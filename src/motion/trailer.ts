// The ad: the gold button starts it with sound and shows the native controls; it pauses when
// scrolled out of view.
import { onPage } from '../engine';

export function startTrailer() {
  onPage(() => {
    const frame = document.querySelector<HTMLElement>('[data-trailer]');
    const video = frame?.querySelector('video');
    const play = frame?.querySelector<HTMLButtonElement>('[data-trailer-play]');
    if (!frame || !video || !play) return;
    const start = () => {
      frame.classList.add('is-playing');
      video.controls = true;
      video.play().catch(() => {});
      video.focus();
    };
    const away = new IntersectionObserver(([e]) => { if (!e.isIntersecting && !video.paused) video.pause(); }, { threshold: 0.2 });
    play.addEventListener('click', start);
    away.observe(video);
    return () => { play.removeEventListener('click', start); away.disconnect(); video.pause(); };
  });
}
