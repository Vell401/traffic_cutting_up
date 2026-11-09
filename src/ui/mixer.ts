import { CHANNELS, type Sound } from '../audio/sound';

/**
 * Volume mixer of the start menu and the pause screen (bottom right): master, engine, road and
 * effects levels, kept in the browser, and the mute switch (also M).
 */
export class Mixer {
  private readonly root = document.getElementById('mixer')!;
  private readonly muteBtn = document.getElementById('muteBtn') as HTMLButtonElement;

  constructor(private readonly sound: Sound) {
    const rows = document.getElementById('mixerRows')!;
    for (const ch of CHANNELS) {
      const row = document.createElement('label');
      row.className = 'mrow';
      row.innerHTML = `<span>${ch.name}</span><input type="range" min="0" max="100" step="1" /><b class="num"></b>`;
      const input = row.querySelector('input')!;
      const out = row.querySelector('b')!;
      const show = () => (out.textContent = String(Math.round(sound.level(ch.id) * 100)));
      input.value = String(Math.round(sound.level(ch.id) * 100));
      input.dataset.channel = ch.id;
      show();
      input.addEventListener('input', () => {
        sound.setLevel(ch.id, Number(input.value) / 100);
        show();
      });
      rows.appendChild(row);
    }
    this.muteBtn.addEventListener('click', () => {
      sound.toggleMute();
      this.sync();
      this.muteBtn.blur();
    });
    // Arrows and Space move a focused slider; they must not steer or start a run.
    for (const type of ['keydown', 'keyup'] as const) this.root.addEventListener(type, (e) => {
      // Esc still closes the pause card after adjusting a focused slider.
      if (e.code === 'Escape' || e.code === 'KeyP') (e.target as HTMLElement).blur();
      else e.stopPropagation();
    });
    this.sync();
    sound.onMixChange(() => this.sync());
  }

  /** Hidden driving controls must neither retain focus nor intercept driving keys. */
  setVisible(visible: boolean): void {
    if (!visible && this.root.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
    this.root.inert = !visible;
  }

  /** Show the mute state (after M). */
  sync(): void {
    for (const input of this.root.querySelectorAll<HTMLInputElement>('input[data-channel]')) {
      const value = Math.round(this.sound.level(input.dataset.channel as import('../audio/sound').Channel) * 100);
      input.value = String(value);
      input.nextElementSibling!.textContent = String(value);
    }
    const muted = this.sound.isMuted;
    this.muteBtn.textContent = muted ? 'Включить' : 'Выключить';
    this.muteBtn.classList.toggle('on', muted);
    this.root.classList.toggle('muted', muted);
  }
}
