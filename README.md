# MODEOS EL OBI

## Arranque

1. Instala Node.js 20 o superior.
2. Ejecuta `npm install`.
3. Copia `.env.example` a `.env` y completa los valores.
4. En Discord Developer Portal configura como redirect URI:
   `http://localhost:3000/auth/discord/callback`
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
3. En el Web Service define `PUBLIC_URL` con `https://web-modeos-el-obi.onrender.com` y usa esa misma URL en `FRONTEND_URL`.
4. En Render, `index.html` detecta su propio origen como `API_URL`. Si alojas el frontend en otro dominio, configura el backend en `<meta name="api-base-url" content="https://TU-DOMINIO-BACKEND">`; las cookies entre dominios pueden bloquearse, por eso se recomienda el origen único.
5. En Discord Developer Portal añade como redirect URI, usando el dominio exacto del Web Service:
   `https://web-modeos-el-obi.onrender.com/auth/discord/callback`
6. Completa en ese mismo servicio Render `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DEV_PASSWORD`, `SESSION_SECRET` y `DATABASE_URL`.
7. El servicio usa el puerto asignado por Render automáticamente. PostgreSQL se conecta mediante `DATABASE_URL`; no se necesita disco persistente para la base de datos.

Para verificar el despliegue, consulta `https://web-modeos-el-obi.onrender.com/api/health`. Debe devolver `status: "ok"`, `database: "connected"` y el commit desplegado en `version`. Si `/` carga la web pero `/api/health` da `404`, ese dominio sigue unido a un Static Site: elimina o reemplaza ese Static Site y crea el Web Service Node con este repositorio y `npm start`.

La aplicación usa PostgreSQL en Neon para conservar los logs y los intentos de acceso al reiniciar o desplegar el servicio.
Al arrancar, el backend crea si faltan las tablas `site_images`, `site_settings` y `site_messages`; no hay que ejecutar un SQL manualmente. El estado público se consulta en `/api/site-state`, y la Zona DEV lo modifica mediante `/api/dev/site-state` y `/api/dev/site-messages`. Las fotos existentes usan `/api/site-images` y `/api/dev/images/:slot`.
