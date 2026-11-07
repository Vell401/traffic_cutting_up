import { loading } from './ui/loading';

loading.begin('boot', 'Ночь принадлежит дороге');
await loading.stage(8, 'Загрузка игры');
try {
  await import('./main');
  loading.finish();
} catch (error) {
  console.error('Game initialization failed', error);
  loading.fail('Не удалось подготовить игру. Проверьте соединение и попробуйте ещё раз.');
}
