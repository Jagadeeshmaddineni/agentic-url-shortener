export const homePage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f3f5ef">
  <title>Shorten a URL</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #18312e;
      --muted: #63726d;
      --paper: #f3f5ef;
      --line: #cbd6cf;
      --green: #b7d9cb;
      --deep-green: #24584d;
      --coral: #c9573b;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      color: var(--ink);
      background-color: var(--paper);
      background-image: radial-gradient(#cad8ce 0.7px, transparent 0.7px);
      background-size: 19px 19px;
      font-family: "Aptos", "Segoe UI", sans-serif;
    }
    .shell { width: min(1040px, calc(100% - 48px)); margin: 0 auto; }
    header {
      height: 76px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--line);
    }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 750; letter-spacing: 0.08em; }
    .brand-mark { width: 22px; height: 22px; display: grid; place-items: center; color: var(--paper); background: var(--deep-green); border-radius: 50%; font: 700 13px Georgia, serif; }
    .header-note { color: var(--muted); font-size: 12px; }
    main { min-height: calc(100vh - 126px); display: grid; grid-template-columns: 0.9fr 1.1fr; align-items: center; gap: 9%; padding: 72px 0 92px; }
    .eyebrow { margin: 0 0 20px; color: var(--coral); font-size: 12px; font-weight: 750; letter-spacing: 0.12em; text-transform: uppercase; }
    h1 { max-width: 440px; margin: 0; font: 500 58px/1.02 "Iowan Old Style", "Palatino Linotype", Georgia, serif; letter-spacing: 0; }
    .accent-line { width: 62px; height: 4px; margin-top: 30px; background: var(--coral); }
    .form-area { padding-top: 8px; }
    label { display: block; margin-bottom: 10px; font-size: 13px; font-weight: 700; }
    .input-row { display: flex; align-items: stretch; gap: 9px; }
    input {
      width: 100%;
      min-width: 0;
      height: 58px;
      padding: 0 17px;
      border: 1px solid #aebdb5;
      border-radius: 3px;
      outline: none;
      color: var(--ink);
      background: #fffefa;
      font: inherit;
      font-size: 15px;
    }
    input:focus { border-color: var(--deep-green); box-shadow: 0 0 0 3px #24584d24; }
    input::placeholder { color: #87958e; }
    button {
      min-height: 58px;
      padding: 0 20px;
      border: 0;
      border-radius: 3px;
      color: white;
      background: var(--deep-green);
      font: inherit;
      font-size: 14px;
      font-weight: 700;
      white-space: nowrap;
      cursor: pointer;
      transition: background-color 140ms ease, transform 140ms ease;
    }
    button:hover { background: #183f37; }
    button:active { transform: translateY(1px); }
    button:focus-visible, a:focus-visible { outline: 3px solid var(--coral); outline-offset: 3px; }
    button:disabled { opacity: 0.65; cursor: wait; }
    .message { min-height: 22px; margin: 10px 0 0; color: #a53b27; font-size: 13px; }
    .result { margin-top: 28px; padding-top: 19px; border-top: 1px solid var(--line); }
    .result-label { margin-bottom: 12px; color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: 0.1em; text-transform: uppercase; }
    .result-row { display: flex; align-items: center; gap: 12px; }
    .short-url { min-width: 0; overflow-wrap: anywhere; color: var(--deep-green); font-size: 18px; font-weight: 700; text-decoration-thickness: 1px; text-underline-offset: 4px; }
    .copy-button { min-height: 40px; padding: 0 13px; border: 1px solid var(--deep-green); color: var(--deep-green); background: transparent; }
    .copy-button:hover { color: white; background: var(--deep-green); }
    footer { height: 50px; display: flex; align-items: center; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
    [hidden] { display: none !important; }
    @media (max-width: 700px) {
      .shell { width: min(100% - 36px, 520px); }
      header { height: 66px; }
      main { min-height: calc(100vh - 116px); grid-template-columns: 1fr; align-content: center; gap: 42px; padding: 58px 0; }
      h1 { max-width: 340px; font-size: 46px; }
      .accent-line { margin-top: 22px; }
      .input-row { flex-direction: column; }
      .input-row button { width: 100%; }
      .header-note { font-size: 11px; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0.01ms !important; } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand"><span class="brand-mark" aria-hidden="true">s</span><span>SHORTFORM</span></div>
      <span class="header-note">A small link utility</span>
    </header>
    <main>
      <section aria-labelledby="page-title">
        <p class="eyebrow">Link desk / 01</p>
        <h1 id="page-title">Shorten a URL.</h1>
        <div class="accent-line" aria-hidden="true"></div>
      </section>
      <section class="form-area" aria-label="Create a short link">
        <form id="shorten-form">
          <label for="destination">Destination URL</label>
          <div class="input-row">
            <input id="destination" name="url" type="url" placeholder="https://example.com/a/long/path" autocomplete="url" required>
            <button id="submit-button" type="submit">Shorten link</button>
          </div>
          <p id="message" class="message" role="alert" aria-live="polite"></p>
        </form>
        <section id="result" class="result" aria-live="polite" hidden>
          <div class="result-label">Your short link</div>
          <div class="result-row">
            <a id="short-url" class="short-url" href="#"></a>
            <button id="copy-button" class="copy-button" type="button">Copy</button>
          </div>
        </section>
      </section>
    </main>
    <footer>HTTP&nbsp;302 <span aria-hidden="true">&nbsp;·&nbsp;</span> Link creation is rate limited</footer>
  </div>
  <script>
    const form = document.querySelector('#shorten-form');
    const input = document.querySelector('#destination');
    const submit = document.querySelector('#submit-button');
    const message = document.querySelector('#message');
    const result = document.querySelector('#result');
    const shortUrl = document.querySelector('#short-url');
    const copyButton = document.querySelector('#copy-button');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = '';
      result.hidden = true;
      submit.disabled = true;
      submit.textContent = 'Creating...';
      try {
        const response = await fetch('/api/v1/links', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: input.value.trim() })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Could not create this link.');
        shortUrl.href = data.shortUrl;
        shortUrl.textContent = data.shortUrl;
        result.hidden = false;
      } catch (error) {
        message.textContent = error.message || 'Could not reach the service. Try again.';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Shorten link';
      }
    });

    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shortUrl.href);
        copyButton.textContent = 'Copied';
        setTimeout(() => { copyButton.textContent = 'Copy'; }, 1400);
      } catch {
        message.textContent = 'Clipboard access is unavailable in this browser.';
      }
    });
  </script>
</body>
</html>`;