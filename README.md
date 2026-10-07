# MODEOS EL OBI

## Notificaciones Discord

Al iniciar `server.js`, el mismo Web Service de Render inicia automaticamente el cliente principal configurado en `DISCORD_BOT_TOKEN` o todas las instancias de `DISCORD_BOTS_JSON`. Cada instancia vuelve a conectar automaticamente tras una desconexion; si el primer inicio falla, se reintenta con espera exponencial hasta un maximo de 60 segundos. La conexion se registra en la consola como `[BOT] Conectado exitosamente...` y conserva su estado `activo`, `beta` o `mantenimiento` en Neon. El plan `starter` del Blueprint mantiene el proceso disponible; `/api/health` informa de las instancias y de los avisos pendientes.

La Zona DEV publica automaticamente en Discord los avisos publicos, los cambios de estado y los inicios de directo. Todas las notificaciones son embeds oficiales e incluyen siempre el enlace `https://web-modeos-el-obi.onrender.com`.

Configura `DISCORD_ANNOUNCEMENTS_CHANNEL_ID`. Puedes separar los destinos con `DISCORD_STATUS_CHANNEL_ID` y `DISCORD_LIVE_CHANNEL_ID`; si se omiten, se usa el canal principal. El bot necesita permiso `View Channel`, `Send Messages` y `Embed Links` en esos canales.

Para varias instancias, configura `DISCORD_BOTS_JSON` en Render como un array JSON, por ejemplo `[ {"name":"MODEOS EL OBI", "token":"TOKEN_1"}, {"name":"Bot secundario", "token":"TOKEN_2"} ]`. Cada nombre y token debe ser unico. Si no se define, se admite el formato anterior con `DISCORD_BOT_TOKEN` y, opcionalmente, `DISCORD_BOT_NAME`. Los tokens solo se leen del entorno: nunca se guardan en Neon ni se envian al frontend. Neon registra automaticamente el ID de Discord y el estado de cada instancia al conectarse. El panel DEV cambia el estado individual; el control de estado global de la web es independiente.

La Zona DEV requiere iniciar sesión con la cuenta de Discord cuyo ID coincida exactamente con `DISCORD_DEV_USER_ID` y, después, introducir `DEV_PASSWORD`. Configura `DISCORD_DEV_USER_ID` con el ID numérico de la cuenta del desarrollador principal; tanto el desbloqueo como cada endpoint de gestión DEV comprueban esta identidad. Si no está configurado, el acceso DEV permanece deshabilitado.

En la Zona DEV puedes añadir bots pegando su token, elegir un servidor al que ya se haya invitado al bot y pulsar **Crear y configurar canales**. Se crea o reutiliza la categoría `ＭＯＤＥＯＳ・ＥＬ・ＯＢＩ` con canales de anuncios, estado web y directos; los tres tipos de aviso se enrutan al bot y servidor seleccionados. También puedes elegir canales de texto existentes para cada tipo de aviso. Cada bot registrado muestra el enlace **Invitar a servidor**, creado con su `client_id` guardado en Neon; la lista y las operaciones de gestión solo están disponibles para la cuenta establecida en `DISCORD_DEV_USER_ID`. En **Comandos por bot** puedes habilitar o deshabilitar las acciones admitidas y ejecutarlas contra una instancia conectada y un servidor seleccionado; `send` además valida que el canal pertenezca a ese servidor. `/setup` crea/reutiliza los canales de avisos y configura sus rutas; el bot necesita `Manage Channels` para ello. `View Channel`, `Send Messages` y `Embed Links` son necesarios para publicar. Los enlaces globales de Twitch y YouTube se guardan desde la Zona DEV; solo aceptan URLs HTTPS de sus dominios oficiales. `DATABASE_URL` debe ser la cadena de conexión PostgreSQL de Neon; al arrancar, el servidor inicializa/migra las tablas y vuelve a iniciar los bots administrados desde la base de datos. `DISCORD_BOT_TOKEN_ENCRYPTION_KEY` debe permanecer estable y secreto (Render puede generarlo con el Blueprint); los tokens añadidos en el panel se guardan cifrados con AES-256-GCM en PostgreSQL. Si se pierde o cambia esta clave, esos bots no podrán reconectarse.

Para eventos emitidos por otro backend, usa `POST /api/integrations/discord/events` con `Content-Type: application/json` y el encabezado `X-Modeos-Webhook-Secret`, cuyo valor debe coincidir con `DISCORD_EVENTS_WEBHOOK_SECRET`.

```json
{
  "type": "developer_announcement",
  "title": "Comunicado oficial",
  "message": "Mensaje para la comunidad"
}
```

```json
{
  "type": "platform_status",
  "platformStatus": "mantenimiento",
  "message": "Actualizamos la plataforma."
}
```

```json
{
  "type": "live_started",
  "title": "Estamos en directo",
  "message": "El directo oficial ha comenzado."
}
```

Los avisos se guardan primero en una cola PostgreSQL. Si el canal principal no esta configurado, se conserva la notificacion pendiente sin detener Express; cuando se configure el canal, o si el bot o Discord estan momentaneamente desconectados, el servicio reintenta al reconectar y cada minuto hasta entregarla.

## Arranque

1. Instala Node.js 20 o superior.
2. Ejecuta `npm install`.
3. Copia `.env.example` a `.env` y completa los valores.
4. En Discord Developer Portal configura como redirect URI:
   `http://localhost:3000/api/auth/discord/callback`
5. Invita el bot con los permisos e intents necesarios.
6. Ejecuta `npm start` y abre `http://localhost:3000`.

## Servicios incluidos

- OAuth de Discord en `/api/auth/discord` y `/api/auth/discord/callback` (las rutas anteriores se mantienen como alias).
- Sesiones HTTP protegidas.
- Bot real conectado mediante `discord.js`.
- Logs del bot por Server-Sent Events en `/api/discord/logs`.
- Reloj y fecha local visibles en la interfaz.
- Imágenes de portada, Modelos y Directos administrables desde la Zona DEV y persistidas en PostgreSQL.
- Estado global de mantenimiento y avisos públicos persistidos en PostgreSQL, con actualizaciones en vivo por Server-Sent Events.
- Banner de consentimiento con categorías esenciales, analíticas y personalización, preferencias revocables y registro de decisión con marca de tiempo.
- Plantillas legales enlazadas desde el footer: privacidad, términos y política de cookies.
- Página independiente de soporte Discord en `soporte.html`, enlazada desde la tarjeta del Lobby.
- Catálogo de comandos/acciones por bot y enlaces de Twitch/YouTube editables desde endpoints protegidos `/api/dev/*`.
- Auditoría DEV en PostgreSQL mediante `/api/dev/security-logs`.
- Bloqueo de contraseña DEV tras cinco intentos fallidos.

No pongas tokens ni secretos dentro de `index.html`. Usa únicamente `.env`.
Las imágenes admitidas son PNG, JPEG y WebP, con un máximo de 2 MB cada una.
Los proveedores opcionales deben registrarse como scripts inertes, por ejemplo `<script type="text/plain" data-consent-category="analytics" data-consent-src="https://proveedor.example/analytics.js"></script>`; `cookies.js` solo los descarga tras consentimiento para su categoría. El Tailwind CDN actual se usa para renderizar la interfaz antes de la elección; la política de cookies lo declara y recomienda alojar localmente Tailwind, fuentes e iconos antes de exigir que no haya solicitudes de terceros previas al consentimiento.
Las páginas legales contienen campos entre corchetes que debe completar y revisar el titular antes de publicarlas. Son plantillas informativas, no asesoramiento ni certificación de cumplimiento.

## Despliegue en Render

1. Despliega el backend de este repositorio como **Web Service** Node en Render. `npm start` inicia Express y `/api/health` es su comprobación de estado.
2. En las variables del backend define `PUBLIC_URL` exactamente como `https://web-modeos-el-obi-backend.onrender.com` (sin `/` final). Esta URL determina el `redirect_uri` enviado a Discord y debe ser el dominio real de este Web Service.
3. El frontend está configurado en `index.html` para llamar al backend `https://web-modeos-el-obi-backend.onrender.com` mediante `<meta name="api-base-url">`. Si cambia el dominio real del backend, actualiza ese valor y `PUBLIC_URL` al mismo tiempo.
4. Define `FRONTEND_URL` con el dominio donde se sirve la web, actualmente `https://web-modeos-el-obi.onrender.com`. El backend ya habilita credenciales CORS y cookies seguras para ese origen.
5. En Discord Developer Portal añade exactamente esta Redirect URI:
   `https://web-modeos-el-obi-backend.onrender.com/api/auth/discord/callback`
6. En ese Web Service configura también `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_DEV_USER_ID` (ID de Discord del desarrollador autorizado), `DEV_PASSWORD`, `SESSION_SECRET` y `DATABASE_URL`.
7. El servicio usa el puerto asignado por Render automáticamente. PostgreSQL se conecta mediante `DATABASE_URL`; no se necesita disco persistente para la base de datos.

Para verificar el backend, consulta `https://web-modeos-el-obi-backend.onrender.com/api/health`. Debe devolver `status: "ok"`, `database: "connected"` y el commit desplegado en `version`. La página pública puede seguir en `https://web-modeos-el-obi.onrender.com`; las llamadas de API y el login se dirigen al host backend configurado en `index.html`.

La aplicación usa PostgreSQL en Neon para conservar los logs y los intentos de acceso al reiniciar o desplegar el servicio.
Al arrancar, el backend crea si faltan las tablas `site_images`, `site_settings` y `site_messages`; no hay que ejecutar un SQL manualmente. El estado público se consulta en `/api/site-state`, y la Zona DEV lo modifica mediante `/api/dev/site-state` y `/api/dev/site-messages`. Las fotos existentes usan `/api/site-images` y `/api/dev/images/:slot`.
