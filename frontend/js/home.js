// Home page after login: greets the user and lists the pages their role can use.
// Owner: Hana Fady (issue #10). Teammates: add your page to PAGES in auth.js.

(() => {
  const user = auth.requireLogin(['Admin', 'Staff', 'Customer']);
  if (!user) return;

  const intros = {
    Admin: 'You manage templates, user accounts and onboarding plans.',
    Staff: 'You work on the onboarding plans and tasks assigned to you.',
    Customer: 'Here you can follow your onboarding plan and complete your tasks.',
  };

  document.getElementById('welcome').textContent = `Welcome, ${user.name}`;
  document.getElementById('role-intro').textContent = intros[user.role] || '';

  const list = document.getElementById('page-list');
  for (const page of auth.pagesFor(user.role)) {
    if (page.href === 'home.html') continue;
    const li = document.createElement('li');
    if (page.ready) {
      const a = document.createElement('a');
      a.href = page.href;
      a.textContent = page.label;
      li.appendChild(a);
    } else {
      li.textContent = `${page.label} (coming soon)`;
      li.className = 'muted';
    }
    list.appendChild(li);
  }
})();
