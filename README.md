# MODEOS EL OBI

## Notificaciones Discord

El mismo Web Service de Render mantiene conectados uno o varios clientes de Discord. Cada instancia vuelve a conectar automaticamente y conserva su estado `activo`, `beta` o `mantenimiento` en Neon. El plan `starter` del Blueprint mantiene el proceso disponible; `/api/health` informa de las instancias y de los avisos pendientes.

La Zona DEV publica automaticamente en Discord los avisos publicos, los cambios de estado y los inicios de directo. Todas las notificaciones son embeds oficiales e incluyen siempre el enlace `https://web-modeos-el-obi.onrender.com`.

Configura `DISCORD_ANNOUNCEMENTS_CHANNEL_ID`. Puedes separar los destinos con `DISCORD_STATUS_CHANNEL_ID` y `DISCORD_LIVE_CHANNEL_ID`; si se omiten, se usa el canal principal. El bot necesita permiso `View Channel`, `Send Messages` y `Embed Links` en esos canales.

Para varias instancias, configura `DISCORD_BOTS_JSON` en Render como un array JSON, por ejemplo `[ {"name":"MODEOS EL OBI", "token":"TOKEN_1"}, {"name":"Bot secundario", "token":"TOKEN_2"} ]`. Cada nombre y token debe ser unico. Si no se define, se admite el formato anterior con `DISCORD_BOT_TOKEN` y, opcionalmente, `DISCORD_BOT_NAME`. Los tokens solo se leen del entorno: nunca se guardan en Neon ni se envian al frontend. Neon registra automaticamente el ID de Discord y el estado de cada instancia al conectarse. El panel DEV cambia el estado individual; el control de estado global de la web es independiente.

Configura `DISCORD_DEV_USER_ID` con el ID numerico de la cuenta Discord autorizada para que las rutas DEV y el desbloqueo por contrasena esten disponibles.

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

Los avisos se guardan primero en una cola PostgreSQL. Si el bot o Discord estan momentaneamente desconectados, el servicio los reintenta al reconectar y cada minuto hasta entregarlos.

## Arranque

1. Instala Node.js 20 o superior.
2. Ejecuta `npm install`.
3. Copia `.env.example` a `.env` y completa los valores.
4. En Discord Developer Portal configura como redirect URI:
   `http://localhost:3000/api/auth/discord/callback`
5. Invita el bot con los permisos e intents necesarios.
6. Ejecuta `npm start` y abre `http://localhost:3000`.

## Servicios incluidos

- OAuth de Discord en `/auth/discord`.
- Sesiones HTTP protegidas.
- Bot real conectado mediante `discord.js`.
- Logs del bot por Server-Sent Events en `/api/discord/logs`.
- Reloj y fecha local visibles en la interfaz.
- Imágenes de portada, Modelos y Directos administrables desde la Zona DEV y persistidas en PostgreSQL.
- Estado global de mantenimiento y avisos públicos persistidos en PostgreSQL, con actualizaciones en vivo por Server-Sent Events.
- Banner de consentimiento con categorías esenciales, analíticas y personalización, preferencias revocables y registro de decisión con marca de tiempo.
- Plantillas legales enlazadas desde el footer: privacidad, términos y política de cookies.
- Página independiente de soporte Discord en `soporte.html`, enlazada desde la tarjeta del Lobby.
- Comandos DEV limitados en `/api/discord/commands`.
- Auditoría DEV en PostgreSQL mediante `/api/dev/security-logs`.
- Bloqueo de contraseña DEV tras cinco intentos fallidos.

No pongas tokens ni secretos dentro de `index.html`. Usa únicamente `.env`.
Las imágenes admitidas son PNG, JPEG y WebP, con un máximo de 2 MB cada una.
Los proveedores opcionales deben registrarse como scripts inertes, por ejemplo `<script type="text/plain" data-consent-category="analytics" data-consent-src="https://proveedor.example/analytics.js"></script>`; `cookies.js` solo los descarga tras consentimiento para su categoría. El Tailwind CDN actual se usa para renderizar la interfaz antes de la elección; la política de cookies lo declara y recomienda alojar localmente Tailwind, fuentes e iconos antes de exigir que no haya solicitudes de terceros previas al consentimiento.
Las páginas legales contienen campos entre corchetes que debe completar y revisar el titular antes de publicarlas. Son plantillas informativas, no asesoramiento ni certificación de cumplimiento.

## Despliegue en Render

1. En Render, este repositorio debe estar desplegado como **Web Service** Node. El Blueprint de `render.yaml` lo nombra `web-modeos-el-obi` y comprueba `/api/health`.
2. `npm start` inicia Express, que sirve `index.html`, los recursos estáticos y la API desde el mismo dominio. No crees un segundo Static Site para esta web.
3. En el Web Service define `PUBLIC_URL` exactamente como `https://web-modeos-el-obi.onrender.com` (sin `/` final) y usa esa misma URL en `FRONTEND_URL`.
4. En Render, `index.html` detecta su propio origen como `API_URL`. Si alojas el frontend en otro dominio, configura el backend en `<meta name="api-base-url" content="https://TU-DOMINIO-BACKEND">`; las cookies entre dominios pueden bloquearse, por eso se recomienda el origen único.
5. En Discord Developer Portal añade como redirect URI, usando el dominio exacto del Web Service:
   `https://web-modeos-el-obi.onrender.com/api/auth/discord/callback`
6. Completa en ese mismo servicio Render `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DEV_PASSWORD`, `SESSION_SECRET` y `DATABASE_URL`.
7. El servicio usa el puerto asignado por Render automáticamente. PostgreSQL se conecta mediante `DATABASE_URL`; no se necesita disco persistente para la base de datos.

Para verificar el despliegue, consulta `https://web-modeos-el-obi.onrender.com/api/health`. Debe devolver `status: "ok"`, `database: "connected"` y el commit desplegado en `version`. Si `/` carga la web pero `/api/health` da `404`, ese dominio sigue unido a un Static Site: elimina o reemplaza ese Static Site y crea el Web Service Node con este repositorio y `npm start`.

La aplicación usa PostgreSQL en Neon para conservar los logs y los intentos de acceso al reiniciar o desplegar el servicio.
Al arrancar, el backend crea si faltan las tablas `site_images`, `site_settings` y `site_messages`; no hay que ejecutar un SQL manualmente. El estado público se consulta en `/api/site-state`, y la Zona DEV lo modifica mediante `/api/dev/site-state` y `/api/dev/site-messages`. Las fotos existentes usan `/api/site-images` y `/api/dev/images/:slot`.
