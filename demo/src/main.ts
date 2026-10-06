import './styles.css';
import { Game } from './game/Game';

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
if (!canvas) throw new Error('Missing #game-canvas element.');

const game = new Game(canvas);
game.start().catch((err) => {
  console.error(err);
  const t = document.querySelector('#load-text');
  if (t) t.textContent = `加载失败：${err instanceof Error ? err.message : String(err)}`;
});

if (import.meta.hot) import.meta.hot.dispose(() => game.dispose());
