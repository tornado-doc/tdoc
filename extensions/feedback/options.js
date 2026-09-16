const form = document.querySelector('form');
const status = document.querySelector('#status');
chrome.storage.sync.get({ documentUrl: '' }).then(({ documentUrl }) => { form.elements.documentUrl.value = documentUrl; });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const documentUrl = form.elements.documentUrl.value.trim();
  if (!/^https?:\/\/[^/]+\/d\/[^/]+(?:\/v\/\d+)?\/?$/.test(documentUrl)) { status.textContent = 'Paste a full tdoc document URL.'; return; }
  await chrome.storage.sync.set({ documentUrl });
  status.textContent = 'Connected';
});
