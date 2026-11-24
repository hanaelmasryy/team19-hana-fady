// Start page: someone who is still logged in in this tab goes straight home.
if (window.auth && auth.getUser()) location.replace(auth.HOME_PAGE);
