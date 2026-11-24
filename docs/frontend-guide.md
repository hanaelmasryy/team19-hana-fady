# Frontend guide: adding a page behind the login

Owner of the shared login code: Hana Fady (issue #10). Read this before building your screens.

## What already exists

| File | What it does |
|---|---|
| `frontend/login.html` + `js/login.js` | Login form. Calls `POST /api/auth/login`, saves the session, then opens the page the user asked for (or `home.html`). Shows "Invalid email or password", the lockout time on 429, and "logged out" / "session ended" notices. |
| `frontend/home.html` + `js/home.js` | First page after login. Greets the user and lists the pages their role can open. |
| `frontend/js/auth.js` | Shared session helpers: `auth.requireLogin(roles)`, `auth.getUser()`, `auth.logout()`, and the page list `PAGES` used for the menu. |
| `frontend/js/api.js` | `api.get / post / put / patch(path, body)`. Adds the token, returns the JSON, and throws an `Error` with `.status` (and `.retryAfter` on 429). A 401 on a logged-in request sends the user back to the login page automatically. |
| `frontend/js/ui.js` | Optional helpers: `ui.el(tag, props, ...children)` builds elements safely (always text, never HTML), plus `ui.showMessage`, `ui.formatDate`, `ui.busy` (disables a button while saving) and `ui.debounce` (search boxes). Load it after `api.js` if you use it. Used by `templates.html` and `users.html`. |

## Make a new page in 4 steps

1. **Copy this HTML** (change the title, the `<main>` content and the last script):

   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8">
     <meta name="viewport" content="width=device-width, initial-scale=1.0">
     <meta name="referrer" content="no-referrer">
     <title>My page · Onboarding Portal</title>
     <link rel="stylesheet" href="css/styles.css">
   </head>
   <body>
     <header class="topbar"><span class="brand">Onboarding Portal</span></header>
     <main class="container">
       <h1>My page</h1>
       <p id="page-error" class="error" role="alert" hidden></p>
       <ul id="item-list"></ul>
     </main>
     <script src="js/config.js"></script>
     <script src="js/auth.js"></script>
     <script src="js/api.js"></script>
     <script src="js/my-page.js"></script>
   </body>
   </html>
   ```

   The script order matters: `config.js`, `auth.js`, `api.js`, then your page script.

2. **Start your page script with `requireLogin`**, listing the roles that may open it. It sends anyone else to the login page (not logged in or session expired) or to home (wrong role), and it fills the top bar with the menu, the user's name and **Log out**:

   ```js
   (async () => {
     const user = auth.requireLogin(['Admin', 'Staff']); // roles allowed on this page
     if (!user) return;

     const errorBox = document.getElementById('page-error');
     try {
       const items = await api.get('/api/your-endpoint');
       const list = document.getElementById('item-list');
       for (const item of items) {
         const li = document.createElement('li');
         li.textContent = item.title; // textContent, never innerHTML
         list.appendChild(li);
       }
     } catch (err) {
       errorBox.textContent = err.message;
       errorBox.hidden = false;
     }
   })();
   ```

3. **Add your page to the menu**: in `frontend/js/auth.js`, find your line in `PAGES` and change `ready: false` to `ready: true`. The `roles` there should match the roles your API route allows. If your page isn't listed, add a line.

4. **Test with each role** (Admin, Staff, Customer): the right people see the link, the wrong role is sent home, and logging out takes you back to the login page.

## Rules (from the threat model)

- **Show data with `textContent`, never `innerHTML`**: names, titles and notes come from users and could contain HTML or script.
- **The browser role is only for showing or hiding things.** Every API route must still use `requireAuth` and `requireRole`; the server is what actually protects the data.
- **No inline scripts or `onclick="..."` attributes**: put code in `js/*.js` and use `addEventListener`.
- **Never put the token or personal data in a URL** (`?token=` or `?email=`). Ids such as `?id=12` are fine.
- **Don't store anything else in `localStorage`.** The session lives in `sessionStorage` and ends when the tab closes.

## Running it on your laptop

1. Make sure `backend/.env` has `CORS_ORIGINS=http://localhost:5500` (or the port your preview uses).
2. API: `cd backend` then `npm start` (runs on http://localhost:3000 against the **dev** database).
3. Website: open the `frontend` folder with VS Code **Live Server** (port 5500), or run `npx serve -l 5500 frontend` from the repository folder.
4. Log in with a dev account. To create the first Admin on dev: set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` in `backend/.env` and run `npm run seed`. After PR #32 is merged, an Admin can create the other accounts with `POST /api/users`.
