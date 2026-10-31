Optional access control for the web service. Any `*.caddy` file in this
directory is imported into the site block. Example `basic.caddy`:

    basic_auth {
        # caddy hash-password --plaintext 'your-password'
        viewer $2a$14$...
    }

No `*.caddy` file means the map is public (the default).
