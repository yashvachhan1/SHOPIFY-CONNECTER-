const ngrok = require('@ngrok/ngrok');

(async function() {
  try {
    const url = await ngrok.connect({ addr: 3000, authtoken_from_env: false, authtoken: '3HDhwXgiGgHO4I7PTLKXLKCZQSZ_4RENnHF3cZ9HpkdwzKgzM' });
    console.log(`Ngrok URL: ${url.url()}`);
    // Keep process alive
    setInterval(() => {}, 1000 * 60 * 60);
  } catch (error) {
    console.error('Error starting ngrok:', error);
  }
})();
