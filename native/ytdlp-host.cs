/*
 * Descargador de medios para X — Host de mensajería nativa para yt-dlp
 * ---------------------------------------------------------------------------
 * Qué es
 *   Un ejecutable pequeño que Chrome lanza cuando la extensión quiere bajar un
 *   vídeo de YouTube. Habla el protocolo de mensajería nativa de Chrome (JSON
 *   con prefijo de longitud de 4 bytes en little-endian por stdin/stdout) y su
 *   única misión es ejecutar `yt-dlp` y contar lo que va pasando.
 *
 * Por qué existe
 *   YouTube dejó de servir archivos descargables al reproductor web: usa SABR
 *   (application/vnd.yt-ump) y firma las URLs, así que una extensión no puede
 *   bajarlos sin descifrar firmas. yt-dlp sí sabe hacerlo y se actualiza a
 *   diario. Esto solo lo llama con los argumentos correctos y traduce su salida.
 *
 * Compilación (lo hace instalar-ytdlp.ps1 con el csc de .NET Framework):
 *   csc /target:exe /out:ytdlp-host.exe /r:System.Web.Extensions.dll native\ytdlp-host.cs
 *
 * Protocolo
 *   Petición  → {"accion":"estado"} | {"accion":"descargar", ...} |
 *               {"accion":"actualizar"} | {"accion":"abrirCarpeta","carpeta":"..."}
 *   Respuesta → mensajes {"tipo":"estado|inicio|progreso|aviso|fin|error", ...}
 *
 * Seguridad
 *   - Solo se ejecuta yt-dlp (su ruta se busca en ubicaciones conocidas; nunca
 *     se acepta una ruta recibida por mensaje). Los argumentos se construyen
 *     aquí como lista y se citan al vuelo: no hay intérprete de por medio, así
 *     que no hay inyección de comandos.
 *   - La carpeta de destino se normaliza y se comprueba que siga estando dentro
 *     de la carpeta de Descargas del usuario.
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class Programa
{
    private const string VERSION_HOST = "1.0.0";
    private const int MAX_MENSAJE = 8 * 1024 * 1024;

    private static readonly object Candado = new object();
    private static Process hijoActual;

    /// <summary>Estado mutable de una descarga (las lambdas no admiten `ref`).</summary>
    private sealed class Trabajo
    {
        public string Archivo = "";
        public readonly StringBuilder Avisos = new StringBuilder();
        public readonly StringBuilder Errores = new StringBuilder();
    }

    private static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); }
        catch (Exception) { }

        var json = NuevoLector();
        try
        {
            byte[] peticion = LeerMensaje();
            if (peticion == null) return 0;

            Dictionary<string, object> datos;
            try
            {
                datos = json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(peticion));
            }
            catch (Exception ex)
            {
                Enviar(json, Error("Petición ilegible: " + ex.Message));
                return 0;
            }
            if (datos == null) return 0;

            switch (Texto(datos, "accion"))
            {
                case "estado": Estado(json); break;
                case "descargar": Descargar(json, datos); break;
                case "actualizar": Actualizar(json); break;
                case "abrirCarpeta": AbrirCarpeta(json, datos); break;
                default:
                    Enviar(json, Error("Acción desconocida: " + Texto(datos, "accion")));
                    break;
            }
            Depurar("accion terminada: " + Texto(datos, "accion"));
        }
        catch (Exception ex)
        {
            try { Enviar(json, Error(ex.Message)); } catch (Exception) { }
            return 1;
        }
        finally
        {
            MatarHijo();
        }
        return 0;
    }

    /* ===================================================================
     * Protocolo de mensajería nativa
     * ================================================================= */

    private static System.Web.Script.Serialization.JavaScriptSerializer NuevoLector()
    {
        var json = new System.Web.Script.Serialization.JavaScriptSerializer();
        json.MaxJsonLength = MAX_MENSAJE;
        return json;
    }

    private static byte[] LeerMensaje()
    {
        Stream entrada = Console.OpenStandardInput();
        byte[] cabecera = new byte[4];
        if (LeerExacto(entrada, cabecera, 4) < 4) return null;

        int longitud = BitConverter.ToInt32(cabecera, 0);
        if (longitud <= 0 || longitud > MAX_MENSAJE) return null;

        byte[] cuerpo = new byte[longitud];
        if (LeerExacto(entrada, cuerpo, longitud) < longitud) return null;
        return cuerpo;
    }

    private static int LeerExacto(Stream flujo, byte[] destino, int cuantos)
    {
        int total = 0;
        while (total < cuantos)
        {
            int n = flujo.Read(destino, total, cuantos - total);
            if (n <= 0) break;
            total += n;
        }
        return total;
    }

    private static void Enviar(System.Web.Script.Serialization.JavaScriptSerializer json, Dictionary<string, object> respuesta)
    {
        byte[] cuerpo = Encoding.UTF8.GetBytes(json.Serialize(respuesta));
        byte[] cabecera = BitConverter.GetBytes(cuerpo.Length);
        if (respuesta.ContainsKey("tipo") && Convert.ToString(respuesta["tipo"]) != "progreso")
            Depurar("envio " + Convert.ToString(respuesta["tipo"]));
        lock (Candado)
        {
            Stream salida = Console.OpenStandardOutput();
            salida.Write(cabecera, 0, 4);
            salida.Write(cuerpo, 0, cuerpo.Length);
            salida.Flush();
        }
    }

    /// <summary>
    /// Traza opcional para soporte: si la variable de entorno XVD_HOST_DEBUG tiene
    /// una ruta, el host escribe ahí lo que va haciendo.
    /// </summary>
    private static void Depurar(string mensaje)
    {
        string ruta = Environment.GetEnvironmentVariable("XVD_HOST_DEBUG");
        if (string.IsNullOrEmpty(ruta)) return;
        try { File.AppendAllText(ruta, DateTime.Now.ToString("HH:mm:ss.fff") + "  " + mensaje + Environment.NewLine); }
        catch (Exception) { }
    }

    private static Dictionary<string, object> Error(string mensaje)
    {
        return new Dictionary<string, object> { { "tipo", "error" }, { "mensaje", mensaje } };
    }

    private static string Texto(Dictionary<string, object> datos, string clave)
    {
        object valor;
        if (datos.TryGetValue(clave, out valor) && valor != null)
            return Convert.ToString(valor, CultureInfo.InvariantCulture);
        return "";
    }

    private static bool Bandera(Dictionary<string, object> datos, string clave)
    {
        object valor;
        if (!datos.TryGetValue(clave, out valor) || valor == null) return false;
        if (valor is bool) return (bool)valor;
        string texto = Convert.ToString(valor, CultureInfo.InvariantCulture).Trim().ToLowerInvariant();
        return texto == "true" || texto == "1" || texto == "si" || texto == "sí";
    }

    /* ===================================================================
     * Localizar yt-dlp, ffmpeg, Python y la carpeta de Descargas
     * ================================================================= */

    private static string[] RutasYtDlp()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string perfil = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return new[] {
            Path.Combine(local, @"Programs\Python\Python312\Scripts\yt-dlp.exe"),
            Path.Combine(local, @"Programs\Python\Python313\Scripts\yt-dlp.exe"),
            Path.Combine(local, @"Programs\Python\Python311\Scripts\yt-dlp.exe"),
            Path.Combine(local, @"Programs\Python\Python310\Scripts\yt-dlp.exe"),
            Path.Combine(local, @"Microsoft\WinGet\Links\yt-dlp.exe"),
            Path.Combine(local, @"Programs\yt-dlp\yt-dlp.exe"),
            Path.Combine(perfil, "yt-dlp.exe"),
            Path.Combine(perfil, @"scoop\shims\yt-dlp.exe"),
            @"C:\ProgramData\chocolatey\bin\yt-dlp.exe",
            @"C:\yt-dlp\yt-dlp.exe"
        };
    }

    private static string BuscarYtDlp()
    {
        foreach (string ruta in RutasYtDlp()) if (File.Exists(ruta)) return ruta;
        return BuscarEnPath("yt-dlp.exe");
    }

    private static bool HayFfmpeg()
    {
        return BuscarEnPath("ffmpeg.exe").Length > 0;
    }

    private static string BuscarEnPath(string nombre)
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string trozo in path.Split(';'))
        {
            if (trozo.Trim().Length == 0) continue;
            try
            {
                string candidato = Path.Combine(trozo.Trim(), nombre);
                if (File.Exists(candidato)) return candidato;
            }
            catch (Exception) { }
        }
        return "";
    }

    private static string BuscarPython()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidatos = {
            Path.Combine(local, @"Programs\Python\Python312\python.exe"),
            Path.Combine(local, @"Programs\Python\Python313\python.exe"),
            Path.Combine(local, @"Programs\Python\Python311\python.exe"),
            @"C:\Python312\python.exe"
        };
        foreach (string ruta in candidatos) if (File.Exists(ruta)) return ruta;
        return BuscarEnPath("python.exe");
    }

    private static string CarpetaDescargas()
    {
        string ruta = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        return Directory.Exists(ruta) ? ruta : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    /* ===================================================================
     * Estado
     * ================================================================= */

    private static void Estado(System.Web.Script.Serialization.JavaScriptSerializer json)
    {
        string ytdlp = BuscarYtDlp();
        Enviar(json, new Dictionary<string, object> {
            { "tipo", "estado" },
            { "ok", ytdlp.Length > 0 },
            { "host", VERSION_HOST },
            { "ytdlp", ytdlp },
            { "version", ytdlp.Length > 0 ? VersionDeYtDlp(ytdlp) : "" },
            { "ffmpeg", HayFfmpeg() },
            { "descargas", CarpetaDescargas() }
        });
    }

    private static string VersionDeYtDlp(string ejecutable)
    {
        try
        {
            var psi = new ProcessStartInfo(ejecutable)
            {
                Arguments = "--version",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using (Process p = Process.Start(psi))
            {
                string salida = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(20000);
                string[] lineas = salida.Split('\n');
                return lineas.Length > 0 ? lineas[0].Trim() : "";
            }
        }
        catch (Exception)
        {
            return "";
        }
    }

    /* ===================================================================
     * Descarga
     * ================================================================= */

    private static void Descargar(System.Web.Script.Serialization.JavaScriptSerializer json, Dictionary<string, object> datos)
    {
        string ytdlp = BuscarYtDlp();
        if (ytdlp.Length == 0)
        {
            Enviar(json, new Dictionary<string, object> {
                { "tipo", "error" },
                { "mensaje", "No se encuentra yt-dlp en este equipo. Ejecuta «Instalar yt-dlp para X media.cmd»." },
                { "codigo", "sin_ytdlp" }
            });
            return;
        }

        string url = Texto(datos, "url");
        if (!Regex.IsMatch(url, @"^https://(www\.|m\.|music\.)?(youtube\.com|youtu\.be)/", RegexOptions.IgnoreCase))
        {
            Enviar(json, new Dictionary<string, object> {
                { "tipo", "error" }, { "mensaje", "Solo se descargan URLs de YouTube." }, { "codigo", "url_invalida" }
            });
            return;
        }

        string destino;
        try
        {
            destino = ResolverDestino(Texto(datos, "carpeta"));
        }
        catch (Exception ex)
        {
            Enviar(json, new Dictionary<string, object> {
                { "tipo", "error" }, { "mensaje", ex.Message }, { "codigo", "carpeta_invalida" }
            });
            return;
        }

        List<string> orden = ConstruirArgumentos(ytdlp, datos, destino);
        Enviar(json, new Dictionary<string, object> {
            { "tipo", "inicio" },
            { "mensaje", "yt-dlp en marcha" },
            { "carpeta", destino },
            { "orden", string.Join(" ", orden.ToArray()) }
        });

        var trabajo = new Trabajo();
        var psi = new ProcessStartInfo(ytdlp)
        {
            Arguments = Combinar(orden, 1),
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            // La entrada del hijo se redirige y se cierra: si heredara la tubería de
            // Chrome, yt-dlp se queda esperando y no llega a arrancar de verdad.
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
            WorkingDirectory = destino
        };
        // yt-dlp es Python: sin esto, los títulos con acentos llegan mal al leerlo por tubería.
        psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        psi.EnvironmentVariables["PYTHONUTF8"] = "1";

        try
        {
            using (Process p = new Process())
            {
                p.StartInfo = psi;
                p.OutputDataReceived += (s, e) => { if (e.Data != null) ProcesarLinea(json, e.Data, trabajo); };
                p.ErrorDataReceived += (s, e) =>
                {
                    if (e.Data == null) return;
                    Depurar("stderr: " + e.Data);
                    string limpia = e.Data.Trim();
                    if (limpia.Length == 0) return;
                    if (trabajo.Errores.Length < 8000) trabajo.Errores.AppendLine(limpia);
                    Enviar(json, new Dictionary<string, object> { { "tipo", "aviso" }, { "mensaje", limpia } });
                };

                Depurar("arrancando: " + psi.Arguments);
                p.Start();
                try { p.StandardInput.Close(); } catch (Exception) { }
                Depurar("arrancado pid=" + p.Id);
                lock (Candado) { hijoActual = p; }
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                Depurar("lectura asincrona lista");

                // Si Chrome cierra la tubería (pestaña cerrada, servicio dormido), se
                // mata yt-dlp para no dejar procesos huérfanos ni archivos a medias.
                var vigilante = new Thread(() => {
                    try
                    {
                        Stream entrada = Console.OpenStandardInput();
                        byte[] basura = new byte[512];
                        while (entrada.Read(basura, 0, basura.Length) > 0) { }
                        try { if (!p.HasExited) p.Kill(); } catch (Exception) { }
                    }
                    catch (Exception) { }
                });
                vigilante.IsBackground = true;
                vigilante.Start();

                p.WaitForExit();
                Depurar("hijo terminado codigo=" + p.ExitCode + " archivo=" + trabajo.Archivo);

                string archivo = trabajo.Archivo;
                if (archivo.Length == 0 || !File.Exists(archivo))
                {
                    string porId = BuscarPorId(destino, Texto(datos, "id"));
                    if (porId.Length > 0) archivo = porId;
                }

                bool correcto = p.ExitCode == 0 && archivo.Length > 0 && File.Exists(archivo);
                var fin = new Dictionary<string, object> {
                    { "tipo", "fin" },
                    { "ok", correcto },
                    { "codigo", p.ExitCode },
                    { "archivo", archivo },
                    { "carpeta", destino },
                    { "kb", archivo.Length > 0 && File.Exists(archivo) ? new FileInfo(archivo).Length / 1024 : 0 }
                };
                if (!correcto)
                    fin["mensaje"] = ExplicarError(trabajo.Errores.ToString() + trabajo.Avisos.ToString());
                Enviar(json, fin);
            }
        }
        catch (Exception ex)
        {
            Enviar(json, Error("No se pudo ejecutar yt-dlp: " + ex.Message));
        }
    }

    /// <summary>Traduce los fallos típicos de yt-dlp a algo accionable en español.</summary>
    private static string ExplicarError(string salida)
    {
        string t = salida ?? "";
        if (Regex.IsMatch(t, @"HTTP Error 403|unable to download video data", RegexOptions.IgnoreCase))
            return "YouTube rechazó la descarga (HTTP 403). Casi siempre es que yt-dlp está desactualizado: pulsa «Actualizar yt-dlp» en el popup.";
        if (Regex.IsMatch(t, @"Sign in to confirm|not a bot", RegexOptions.IgnoreCase))
            return "YouTube pide iniciar sesión para comprobar que no eres un robot. Activa «Usar las cookies de Chrome» en el popup y reinténtalo.";
        if (Regex.IsMatch(t, @"Could not copy Chrome cookie database|could not find .* cookies database|failed to decrypt", RegexOptions.IgnoreCase))
            return "Chrome tiene la base de datos de cookies bloqueada mientras está abierto. Cierra Chrome por completo y vuelve a intentarlo, o desactiva «Usar las cookies de Chrome».";
        if (Regex.IsMatch(t, @"Private video|video is private", RegexOptions.IgnoreCase))
            return "El vídeo es privado.";
        if (Regex.IsMatch(t, @"members-only|Join this channel", RegexOptions.IgnoreCase))
            return "El vídeo es solo para miembros del canal.";
        if (Regex.IsMatch(t, @"age|restricted", RegexOptions.IgnoreCase) && Regex.IsMatch(t, @"confirm|sign in|inicia sesión", RegexOptions.IgnoreCase))
            return "El vídeo tiene restricción de edad. Activa «Usar las cookies de Chrome» en el popup.";
        if (Regex.IsMatch(t, @"Requested format is not available", RegexOptions.IgnoreCase))
            return "YouTube no ofrece el formato pedido para este vídeo. Prueba con MP4 o M4A.";
        if (Regex.IsMatch(t, @"is unavailable|Video unavailable|has been removed", RegexOptions.IgnoreCase))
            return "El vídeo no está disponible (puede haberse borrado o estar bloqueado en tu región).";
        if (Regex.IsMatch(t, @"ffmpeg", RegexOptions.IgnoreCase) && Regex.IsMatch(t, @"not (found|installed)|no such file", RegexOptions.IgnoreCase))
            return "Falta ffmpeg: hace falta para unir imagen y sonido y para el MP3. Instálalo (por ejemplo «winget install ffmpeg») y reinténtalo.";

        string ultima = "";
        foreach (string linea in t.Split('\n'))
            if (linea.IndexOf("ERROR", StringComparison.OrdinalIgnoreCase) >= 0) ultima = linea.Trim();
        if (ultima.Length > 0) return ultima;
        return "yt-dlp terminó con error. Mira el registro de diagnóstico de la extensión.";
    }

    /* ===================================================================
     * Argumentos de yt-dlp
     * ================================================================= */

    private static List<string> ConstruirArgumentos(string ytdlp, Dictionary<string, object> datos, string destino)
    {
        string formato = Texto(datos, "formato").ToLowerInvariant();
        string calidad = Regex.Replace(Texto(datos, "calidad"), @"[^0-9]", "");
        string plantilla = Texto(datos, "plantilla");
        if (plantilla.Length == 0) plantilla = "youtube_%(uploader)s_%(title)s_%(id)s.%(ext)s";

        var orden = new List<string> { ytdlp };
        orden.Add("--newline");
        orden.Add("--progress");
        orden.Add("--no-playlist");
        orden.Add("--windows-filenames");
        orden.Add("--trim-filenames");
        orden.Add("180");
        orden.Add("--no-mtime");
        orden.Add("--retries");
        orden.Add("5");
        orden.Add("--fragment-retries");
        orden.Add("5");
        orden.Add("--no-color");
        orden.Add("--print");
        orden.Add("after_move:filepath");

        orden.Add("-P");
        orden.Add(destino);
        orden.Add("-o");
        orden.Add(plantilla);

        if (formato == "m4a")
        {
            orden.Add("-f");
            orden.Add("ba[ext=m4a]/ba/b");
        }
        else if (formato == "mp3")
        {
            orden.Add("-f");
            orden.Add("ba/b");
            orden.Add("-x");
            orden.Add("--audio-format");
            orden.Add("mp3");
            orden.Add("--audio-quality");
            orden.Add("0");
        }
        else if (formato == "webm")
        {
            orden.Add("-f");
            orden.Add("bv*[ext=webm]+ba[ext=webm]/b[ext=webm]/bv*+ba/b");
            orden.Add("--merge-output-format");
            orden.Add("webm");
        }
        else
        {
            orden.Add("-f");
            orden.Add("bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b");
            orden.Add("--merge-output-format");
            orden.Add("mp4");
        }

        if (calidad.Length > 0)
        {
            orden.Add("-S");
            orden.Add("res:" + calidad);
        }

        // H.264 (por defecto): se ve en cualquier reproductor. VP9/AV1 dan más
        // calidad por byte, pero no todos los programas los reproducen.
        if (Texto(datos, "codec") != "max" && (formato == "mp4" || formato == "" || formato == "auto"))
        {
            orden.Add("-S");
            orden.Add("vcodec:h264");
        }

        if (Bandera(datos, "cookies"))
        {
            orden.Add("--cookies-from-browser");
            orden.Add("chrome");
        }

        orden.Add(Texto(datos, "url"));
        return orden;
    }

    /// <summary>Compone la línea de argumentos citando cada uno como pide Windows.</summary>
    private static string Combinar(List<string> orden, int desde)
    {
        var texto = new StringBuilder();
        for (int i = desde; i < orden.Count; i++)
        {
            if (texto.Length > 0) texto.Append(' ');
            texto.Append(Citar(orden[i]));
        }
        return texto.ToString();
    }

    private static string Citar(string valor)
    {
        if (valor.Length > 0 && valor.IndexOfAny(new[] { ' ', '\t', '"', '&', '^', '(', ')', '%', '!', '<', '>', '|' }) < 0)
            return valor;

        var salida = new StringBuilder("\"");
        int barras = 0;
        foreach (char c in valor)
        {
            if (c == '\\') { barras++; continue; }
            if (c == '"')
            {
                salida.Append('\\', barras * 2 + 1);
                salida.Append('"');
                barras = 0;
                continue;
            }
            salida.Append('\\', barras);
            barras = 0;
            salida.Append(c);
        }
        salida.Append('\\', barras * 2);
        salida.Append('"');
        return salida.ToString();
    }

    /* ===================================================================
     * Lectura de la salida de yt-dlp
     * ================================================================= */

    private static readonly Regex RE_PROGRESO = new Regex(
        @"^\[download\]\s+(?<pct>[\d.]+)%(?:\s+of\s+~?\s*(?<total>[\d.]+)(?<unidad>[KMG]iB))?" +
        @"(?:\s+at\s+(?<vel>[^\s]+))?(?:\s+ETA\s+(?<eta>[\d:]+|Unknown))?",
        RegexOptions.IgnoreCase);

    private static readonly Regex RE_DESTINO = new Regex(
        @"(?:Destination|Merging formats into|has already been downloaded|Moving file to)\s*:?\s*""?(?<ruta>.+?)""?\s*$",
        RegexOptions.IgnoreCase);

    private static void ProcesarLinea(System.Web.Script.Serialization.JavaScriptSerializer json, string linea, Trabajo trabajo)
    {
        string limpia = (linea ?? "").Trim();
        if (limpia.Length == 0) return;

        // 1. Ruta final: la que imprime --print after_move:filepath o los avisos propios.
        if (Regex.IsMatch(limpia, @"^[A-Za-z]:\\") && limpia.IndexOf(' ') < limpia.Length)
        {
            string posible = limpia.Trim('"');
            if (File.Exists(posible)) { trabajo.Archivo = Path.GetFullPath(posible); return; }
        }

        Match destino = RE_DESTINO.Match(limpia);
        if (destino.Success)
        {
            string posible = destino.Groups["ruta"].Value.Trim().Trim('"');
            if (posible.Length > 0 && File.Exists(posible)) trabajo.Archivo = Path.GetFullPath(posible);
        }

        // 2. Progreso.
        Match p = RE_PROGRESO.Match(limpia);
        if (p.Success)
        {
            var mensaje = new Dictionary<string, object> { { "tipo", "progreso" } };
            double pct;
            if (double.TryParse(p.Groups["pct"].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out pct))
                mensaje["porcentaje"] = Math.Round(pct, 1);
            if (p.Groups["total"].Success) mensaje["total"] = p.Groups["total"].Value + p.Groups["unidad"].Value;
            if (p.Groups["vel"].Success && p.Groups["vel"].Value != "Unknown") mensaje["velocidad"] = p.Groups["vel"].Value;
            if (p.Groups["eta"].Success) mensaje["eta"] = p.Groups["eta"].Value;
            Enviar(json, mensaje);
            return;
        }

        // 3. Avisos que merece la pena contar (cliente elegido, fusión, recodificado…).
        if (Regex.IsMatch(limpia, @"^\[(youtube|info|Merger|ExtractAudio|FixupM4a|FixupM3u8|Metadata|EmbedThumbnail|download)\]", RegexOptions.IgnoreCase)
            || limpia.IndexOf("ERROR", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            if (trabajo.Avisos.Length < 4000) trabajo.Avisos.AppendLine(limpia);
            Enviar(json, new Dictionary<string, object> { { "tipo", "aviso" }, { "mensaje", limpia } });
        }
    }

    /// <summary>Respaldo: el archivo más reciente de la carpeta que contenga el id.</summary>
    private static string BuscarPorId(string carpeta, string id)
    {
        if (id.Length < 6) return "";
        string limpio = Regex.Replace(id, @"[^A-Za-z0-9_-]", "");
        if (limpio.Length < 6) return "";
        try
        {
            string mejor = "";
            DateTime mejorFecha = DateTime.MinValue;
            foreach (string ruta in Directory.GetFiles(carpeta, "*" + limpio + "*"))
            {
                if (ruta.EndsWith(".part", StringComparison.OrdinalIgnoreCase)) continue;
                DateTime fecha = File.GetLastWriteTimeUtc(ruta);
                if (fecha > mejorFecha) { mejorFecha = fecha; mejor = ruta; }
            }
            return mejor;
        }
        catch (Exception)
        {
            return "";
        }
    }

    /* ===================================================================
     * Actualizar yt-dlp y abrir carpetas
     * ================================================================= */

    private static void Actualizar(System.Web.Script.Serialization.JavaScriptSerializer json)
    {
        string ytdlp = BuscarYtDlp();
        var salida = new StringBuilder();
        bool ok;

        if (ytdlp.Length == 0)
        {
            Enviar(json, new Dictionary<string, object> {
                { "tipo", "error" }, { "mensaje", "No se encuentra yt-dlp. Ejecuta «Instalar yt-dlp para X media.cmd»." }
            });
            return;
        }

        string python = BuscarPython();
        bool instaladoConPip = ytdlp.IndexOf(@"\Scripts\yt-dlp.exe", StringComparison.OrdinalIgnoreCase) >= 0;

        if (instaladoConPip && python.Length > 0)
        {
            Enviar(json, new Dictionary<string, object> { { "tipo", "aviso" }, { "mensaje", "Actualizando con pip (puede tardar un poco)…" } });
            ok = Ejecutar(python, new[] { "-m", "pip", "install", "-U", "yt-dlp" }, salida);
        }
        else
        {
            Enviar(json, new Dictionary<string, object> { { "tipo", "aviso" }, { "mensaje", "Actualizando con yt-dlp -U…" } });
            ok = Ejecutar(ytdlp, new[] { "-U" }, salida);
        }

        string version = VersionDeYtDlp(BuscarYtDlp());
        string texto = salida.ToString();
        if (texto.Length > 1200) texto = texto.Substring(texto.Length - 1200);
        Enviar(json, new Dictionary<string, object> {
            { "tipo", "fin" }, { "ok", ok }, { "version", version }, { "salida", texto.Trim() }
        });
    }

    private static bool Ejecutar(string ejecutable, string[] argumentos, StringBuilder salida)
    {
        try
        {
            var psi = new ProcessStartInfo(ejecutable)
            {
                Arguments = Combinar(new List<string>(argumentos), 0),
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using (Process p = Process.Start(psi))
            {
                salida.Append(p.StandardOutput.ReadToEnd());
                salida.Append(p.StandardError.ReadToEnd());
                p.WaitForExit(600000);
                return p.ExitCode == 0;
            }
        }
        catch (Exception ex)
        {
            salida.Append(ex.Message);
            return false;
        }
    }

    private static void AbrirCarpeta(System.Web.Script.Serialization.JavaScriptSerializer json, Dictionary<string, object> datos)
    {
        try
        {
            string ruta = ResolverDestino(Texto(datos, "carpeta"));
            Process.Start(new ProcessStartInfo("explorer.exe", "\"" + ruta + "\"") { UseShellExecute = true });
            Enviar(json, new Dictionary<string, object> { { "tipo", "fin" }, { "ok", true }, { "carpeta", ruta } });
        }
        catch (Exception ex)
        {
            Enviar(json, Error(ex.Message));
        }
    }

    /* ===================================================================
     * Carpetas
     * ================================================================= */

    /// <summary>
    /// Resuelve la subcarpeta pedida dentro de Descargas. Se acepta "A/B" pero
    /// nunca nada que se salga de Descargas (ni "..", ni rutas absolutas).
    /// </summary>
    private static string ResolverDestino(string carpeta)
    {
        string baseDescargas = Path.GetFullPath(CarpetaDescargas());
        if (carpeta == null) carpeta = "";

        var limpios = new List<string>();
        foreach (string trozo in carpeta.Replace('\\', '/').Split('/'))
        {
            string parte = trozo.Trim().TrimEnd('.');
            foreach (char invalido in Path.GetInvalidFileNameChars()) parte = parte.Replace(invalido, '_');
            if (parte.Length > 120) parte = parte.Substring(0, 120).TrimEnd('.');
            if (parte.Length == 0 || parte == "." || parte == "..") continue;
            limpios.Add(parte);
        }

        string destino = baseDescargas;
        foreach (string parte in limpios) destino = Path.Combine(destino, parte);

        string completo = Path.GetFullPath(destino);
        string prefijo = baseDescargas.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!completo.StartsWith(prefijo, StringComparison.OrdinalIgnoreCase))
            throw new Exception("La carpeta de destino tiene que estar dentro de Descargas.");

        Directory.CreateDirectory(completo);
        return completo;
    }

    private static void MatarHijo()
    {
        lock (Candado)
        {
            try { if (hijoActual != null && !hijoActual.HasExited) hijoActual.Kill(); }
            catch (Exception) { }
        }
    }
}
