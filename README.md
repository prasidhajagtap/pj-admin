# PJ Database (admin)

Web admin for the PJ app's MySQL database, served by GitHub Pages:
**https://prasidhajagtap.github.io/pj-admin/**

- Sign in with an admin Google account (allow-list on the server).
- Browse, search and sort tables; add, edit and delete rows; SQL editor for longer queries.
- **Changes** tab: timeline of every approved change to the PJ project.

This repo holds only the static page; no data or secrets. The page talks to the PJ server's
`/admin` API through the server's current Cloudflare Tunnel address, which the server publishes
to `server.json` on the `server-info` branch when it starts.

Changes to `main` go through pull requests.

---
© 2026 Prasidha Jagtap. All rights reserved. Developed by Prasidha Jagtap.
