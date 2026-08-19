/** Progressive code-fence copy controls, inserted only when JavaScript runs. */

export {};

const article = document.querySelector<HTMLElement>('.prose[data-code-copy]');
const idle = article?.dataset['codeCopy'];
const copied = article?.dataset['codeCopied'];
const failed = article?.dataset['codeCopyFailed'];
if (article && idle && copied && failed && typeof navigator.clipboard?.writeText === 'function') {
  for (const code of article.querySelectorAll<HTMLElement>('.code-block > pre > code')) {
    const figure = code.closest<HTMLElement>('.code-block');
    if (!figure || figure.querySelector('.code-copy') !== null) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = idle;
    const status = document.createElement('span');
    status.className = 'sr-only';
    status.setAttribute('role', 'status');
    let resetTimer: number | undefined;
    button.addEventListener('click', async () => {
      if (resetTimer !== undefined) window.clearTimeout(resetTimer);
      button.disabled = true;
      try {
        await navigator.clipboard.writeText(code.textContent ?? '');
        button.textContent = copied;
        status.textContent = copied;
      } catch {
        button.textContent = failed;
        status.textContent = failed;
      } finally {
        button.disabled = false;
        resetTimer = window.setTimeout(() => {
          button.textContent = idle;
          status.textContent = '';
          resetTimer = undefined;
        }, 1600);
      }
    });
    figure.prepend(status);
    figure.prepend(button);
  }
}
