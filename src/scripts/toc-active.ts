/** Mark the section currently crossing the reading offset in the static TOC. */

export {};

const links = [...document.querySelectorAll<HTMLAnchorElement>('.toc a[href^="#"]')];
const targets = links.flatMap((link) => {
  const id = decodeURIComponent(link.hash.slice(1));
  const heading = document.getElementById(id);
  return heading instanceof HTMLElement ? [{ heading, link }] : [];
});

if (targets.length > 0) {
  let frame: number | undefined;
  const update = (): void => {
    frame = undefined;
    const scrollPadding =
      Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    const offset = Math.min(scrollPadding + 1, window.innerHeight / 3);
    let active = targets[0]!;
    for (const target of targets) {
      if (target.heading.getBoundingClientRect().top > offset) break;
      active = target;
    }
    for (const target of targets) {
      if (target === active) target.link.setAttribute('aria-current', 'location');
      else target.link.removeAttribute('aria-current');
    }
  };
  const schedule = (): void => {
    if (frame === undefined) frame = window.requestAnimationFrame(update);
  };
  update();
  // This static site has no client navigation: one module instance and these
  // listeners share the document lifetime, so there is no teardown boundary.
  // Smooth hash navigation emits scroll events throughout its movement.
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
}
