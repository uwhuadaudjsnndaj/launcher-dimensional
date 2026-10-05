# Dimensional Studio Launcher

Launcher de Minecraft (modo offline / no premium) para **Dimensional Studio**, compañía de eventos de Minecraft.

- Inicio de sesión con Discord; el perfil (foto, nombre y @usuario) aparece arriba a la izquierda
- Elección de nombre de jugador (3–16 caracteres: letras, números y `_`)
- Tres servidores: **JustSafio** (disponible) y dos **Próximamente**
- Estado en vivo de cada servidor (en línea, jugadores, sin conexión)
- Cada servidor tiene su propia instancia (mods, configs y mundos separados)
- Descarga mods automáticamente desde un manifiesto; soporta Forge, Fabric o Vanilla
- Discord Rich Presence: "En el launcher" / "Jugando JustSafio"
- Pantalla de **Configuración**: memoria RAM, ruta de Java, conexión automática, pantalla completa, minimizar al jugar y actividad en Discord (se guarda sola en tu equipo)
- Tema rojo y negro basado en el logo (`renderer/assets/logo.png`)

## Novedades 1.3.0

- **Aviso tras actualizar**: la primera vez que se abre una versión nueva sale "Actualizado a la X" con la lista de cambios (se lee de la descripción de la Release en GitHub, que sale de `NOVEDADES.md`)
- **Errores de actualización visibles**: si falla, el launcher dice qué pasó y muestra el botón *Reintentar*
- **Estado por servidor** en cada tarjeta: *No instalado*, *Instalado*, *Actualización disponible* y *Preparando…*; el botón cambia a *Instalar y jugar* / *Actualizar y jugar* cuando hace falta
- **Avisos de Windows** (solo con el launcher minimizado): actualización lista, servidor preparado y Minecraft cerrado con error; se desactivan en Configuración
- **Insignia de rol de Discord** junto al perfil (Owner, Co-Owner, Developer, Helper, VIP, Media, Miembro)
- **Registro en Discord**: al entrar a un servidor se envía "X se unió a JustSafio" a un canal del staff por webhook

### Insignias de rol

`config.json` → `discord.guildId` es el servidor y `roles` la lista de insignias, **de mayor a menor importancia**
(si el jugador tiene varios roles se muestra el primero de la lista). Cada rol lleva `id`, `label` y `color`.
El inicio de sesión pide el permiso `guilds.members.read`; quien ya tenía la sesión iniciada debe cerrar sesión y
volver a entrar una vez para que aparezca su insignia.

### Registro en Discord (webhook)

La URL del webhook **no va en el repositorio** (es público). Se guarda así:

- En tu PC, para `npm start`: copia `private.example.json` a `private.json` y pega la URL (ya está en `.gitignore`).
- Para el instalador publicado: en GitHub → *Settings → Secrets and variables → Actions* crea el secreto
  `DISCORD_WEBHOOK_URL`. El workflow lo escribe en `private.json` al construir.

Sin webhook el launcher funciona igual, simplemente no registra nada. Como la URL va dentro de la app instalada,
alguien con conocimientos podría extraerla: lo peor que puede hacer es escribir en ese canal, y si pasa basta con
regenerar el webhook en Discord y actualizar el secreto.

### Novedades de cada versión

Antes de publicar, edita `NOVEDADES.md` (una línea por cambio, con `- `). Ese texto se publica como descripción de la
Release y es lo que ven los jugadores al actualizar.

## Novedades 1.2.0

- **Tiempo jugado** por servidor (se muestra en cada tarjeta y se guarda por cuenta de Discord)
- **Si Minecraft se cierra con error**: aviso con diagnóstico, botón *Copiar registro* y *Abrir crash report*
- **Configuración avanzada**: argumentos JVM, resolución de ventana, RAM recomendada según tu equipo y aviso si asignas demasiada
- **Skin**: guarda el nombre de una cuenta de Minecraft y copia el comando `/skin set` para SkinsRestorer
- **Tutorial** la primera vez que se abre (se puede repetir desde Configuración)
- Corrección: la conexión automática al servidor ahora usa `quickPlay` (antes se enviaba como argumento de Java)

## Ejecutar

```
npm install
npm start
```

Instalador de Windows: `npm run dist` (crea el acceso directo en el escritorio y en el menú Inicio, con el logo de Dimensional Studio).

## Discord

En https://discord.com/developers/applications → tu aplicación → **OAuth2 → Redirects**
agrega `http://localhost:53682/callback`.

Para el logo del estado: **Rich Presence → Art Assets**, sube una imagen cuadrada (mín. 512×512)
llamada `logo`.

## Configurar servidores (`config.json`)

Cada entrada de `servers`:

| Campo | Qué es |
|---|---|
| `id` | Identificador único (nombre de su carpeta de instancia) |
| `name` / `description` | Texto de la tarjeta |
| `status` | `available` (se puede jugar) o `soon` (próximamente) |
| `ip` / `port` | Dirección del servidor |
| `minecraftVersion` | Ej. `1.20.1` |
| `loader` | `{ "type": "forge" \| "fabric" \| "vanilla", "version": "47.3.0" }` |
| `modsManifestUrl` | URL pública del manifiesto de mods (vacío = sin mods) |
| `accent` | Dos colores para el degradado de la tarjeta |

Para activar un servidor nuevo, cambia su `status` a `available` y rellena `ip`, `port`,
`minecraftVersion` y `loader`. Mira `manifest.example.json` para el formato del manifiesto.

Valores globales: `ram`, `javaPath` y `discord` (Client ID, invitación, `requiredGuildId` opcional).
`ram` y `javaPath` son solo los valores iniciales: cada jugador los cambia desde **Configuración**.

## Logo

- `renderer/assets/logo.png` y `icon.png`: logo completo (ícono de la ventana)
- `renderer/assets/logo-crop.png`: recorte que se muestra en el launcher
- `build/icon.ico`: ícono del instalador de Windows

Si tienes el logo en mayor resolución (512×512 o más), reemplaza esos archivos para que se vea más nítido.


## Un jugador por IP

El launcher consulta un **registro central** (`registry-server/`) que ve la IP pública de cada jugador.
Una IP solo puede pertenecer a una cuenta de Discord: el jugador puede cambiar su nombre cuando quiera,
pero otra cuenta no puede registrarse desde esa misma IP. Se verifica al iniciar sesión, al guardar el
nombre y al darle a jugar. Si el registro no responde, el launcher no deja jugar.

1. Sube la carpeta `registry-server/` a un VPS/hosting con Node 18+ y ejecuta:
   `API_KEY=tu_clave PORT=8787 node server.js` (si va detrás de nginx/Cloudflare añade `TRUST_PROXY=1`).
2. En `config.json` pon `registry.url` (y `registry.apiKey` con la misma clave).
3. Los datos quedan en `registry-server/players.json` (haz copia de seguridad).

Límites: IP compartida (hermanos, misma red, VPN) cuenta como una sola persona; quien cambie de IP
o use VPN puede registrar otra cuenta. Es lo más que se puede lograr sin verificar cuentas premium.

## Publicar e instalar desde GitHub (con actualizaciones automáticas)

0. **Atajo:** haz doble clic en `PUBLICAR.bat` (ya apunta a tu repositorio) y hace todo lo de abajo solo.
1. Crea un repositorio **público** en GitHub (ej. `dimensional-studio-launcher`) y en `package.json`
   cambia `build.publish[0].owner` por tu usuario (y `repo` si usaste otro nombre).
2. Sube el proyecto:
   `git init && git add . && git commit -m "Launcher" && git branch -M main`
   `git remote add origin https://github.com/TU_USUARIO/dimensional-studio-launcher.git && git push -u origin main`
3. Publica la primera versión: `git tag v1.3.0 && git push origin v1.3.0`.
   GitHub Actions construye el instalador y lo sube a **Releases**; ahí lo descarga la gente
   (`Dimensional-Studio-Setup-1.3.0.exe`).
4. Para una actualización: sube `version` en `package.json` (ej. `1.1.1`), haz commit y
   `git tag v1.1.1 && git push origin main v1.1.1`. Los launchers instalados la descargan solos
   (al abrir y cada hora), muestran el aviso "Reiniciar y actualizar" y también se instala al cerrar.

Notas: el repositorio debe ser público para que el actualizador pueda leer los Releases. Como el instalador
no está firmado, Windows SmartScreen mostrará "Windows protegió tu PC" la primera vez (Más información → Ejecutar
de todas formas). La actualización solo funciona en la app instalada, no con `npm start`.
