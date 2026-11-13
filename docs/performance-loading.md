# Загрузка и производительность

## Что изменено

- Обычный выход в меню сохраняет страницу, WebGL-контекст, декодированные модели и шейдеры.
- Собственные машины кэшируются (не более четырёх); повторный выбор не запускает заново HTTP/GLB parsing и подготовку тех же программ.
- Вход готовит только выбранный автомобиль. Удалённые игроки сначала отображаются дешёвой моделью, подробная догружается рядом. Подготовка нескольких удалённых машин выполняется последовательно, без одновременного скачка нагрузки.
- В одиночном режиме HTTP-запрос настроек не блокирует загрузку и вход в меню. Онлайн получает настройки только из WebSocket: поздний HTTP-ответ не может откатить серверные значения. Убрано искусственное ожидание почти секунду в конце каждого экрана загрузки.
- Процедурные модели трафика используют bounded-кэш; на GPU передаются только занятые диапазоны instance-буферов, а не весь резерв.
- Для A45 три карты, которые адаптер всё равно заменяет материалами фар, не декодируются: примерно 33 MiB экономии decoded RAM. Подробные текстуры, геометрия и исходные GLB не изменены.
- Production build создаёт lossless `.glb.gz`; Caddy отдаёт готовое сжатие без его пересчёта на каждый запрос. Экономия передачи текущих моделей — около 6–8%. Неизменившиеся модели/аудио поддерживают HTTP 304, JS с хешем — immutable cache.

## Ограничения

### Authored Miami environment

Miami additionally awaits `View.prepareEnvironment()` under the initial loader:
local manifest + GLB + nine shared photo maps + HDR, attachment, PMREM, compile and
upload. Required failure keeps the menu locked and offers a real retry; Highway is
a no-op. Optional remote-car failure does not become an environment failure. The
environment and all four selected-car views stay resident on ordinary menu return.

The new kit is 28.72 MiB before the manifest, 10 source textures, 74 instanced
prototype/material parts, with fixed explicit placement capacities. The GLB
intentionally contains no images: runtime restores manifest maps with sRGB diffuse,
linear normal/roughness, `flipY=false`, metric UVs and scalar × roughness-map G.
Blender source and restored previews use the same scalar/G sampling contract.
Only distant island towers additionally own two tiny metadata textures and opaque
colour/depth coverage variants, warmed by the same loader. The 100/600m close-detail
window is unchanged; the separate bounded 300/1000m skyline range transitions only
outside its full-coverage interval. Steady movement/rebase does not rebuild or
upload instance/metadata buffers. See the asset contract for ownership/bounds.

Miami opts into lossless static car batching by material/motion domain; original
vehicle assets/builders, animation and Highway stay untouched. Transparent spawn
ghosts keep the original ordered colour draws and can exceed 500 calls. The stated
500-call/5M-triangle rejection bounds apply to **normal opaque selected-car reference
poses at fixed Medium/DPR1**, including shadows/post, not every multiplayer/ghost
frame. No DPR/preset/range/detail cut was added for this art rebuild. Counters and
software-WebGL images are not physical-GPU/FPS/VRAM proof. See the
[rebuild evidence and reproduction commands](reviews/2026-11-13-miami-asset-rebuild.md).

### Готовность и текущие доказательства (13.11.2026)

Выбранная машина прикрепляется до сериализованной compile→draw подготовки exterior/cockpit/opaque/ghost вариантов, с восстановлением renderer/object state при ошибке. Solo сначала проверяет кандидат и живой draw, затем меняет identity/run; принятая online identity сохраняется при visual failure, повтор действительно готовит её заново. Ошибочная attachment-инстанция удаляется из кэша; загрузка выбранной машины до доступного меню намеренна. Lazy remote сохраняет proxy до завершения подготовки: загрузки текстур/геометрии и warm draws разбиты на очереди, но не каждый вызов драйвера делим.

Актуальный renderer Task7: Medium, DPR1, 1280×800, Edge/ANGLE SwiftShader. Все четыре машины × пять первых камер дали ноль дополнительных `compileShader`, `bufferData`, `texImage2D`, `texStorage2D` в измеренных переходах. Bumper теперь скрывает только кузов/тень/колёса, сохраняя две фары: это **исправление картинки**, не эквивалентность прежнему виду без фар. Task4 отдельно проверил три реальных GLTF decode для трёх импортированных моделей и неизменные root/geometry/material/texture при возврате ко всем четырём резидентным машинам; Task7 подтвердил текущие camera/cache-entrypoint свойства. Старые exact-HEAD скрипты Task4 нельзя запускать без адаптации к новой семантике bumper.

Ограничение не снято: Task7 remote preparation заняла **67 864,3 мс**, отдельный `initTexture` — до **3370,6 мс**, warm draw — **2927,5 мс**, sampled rAF p95 **1721,4 мс**, max **2485,2 мс**. Task4 также видел многосекундный cockpit submission при нулевых перечисленных счётчиках. Нулевые счётчики этих четырёх методов не означают нулевой driver latency, отсутствия динамических uploads или плавной езды. Малый warm target не уменьшает размер загружаемых ресурсов. Реальный GPU/телефон/VRAM/FPS и VPS не проверены. Адаптивный DPR существовал ранее и не считается новой оптимизацией; сравнения выполнялись с фиксированными качеством/DPR.

Артефакты, источники и команды постоянной интеграционной приёмки: [reviews/2026-11-13-miami-upgrade.md](reviews/2026-11-13-miami-upgrade.md).

У A45 остаются тяжёлые подробные карты. Оценка RGBA8+mip по всем изображениям — около 859 MiB; это не измерение фактической VRAM и не учитывает совместное использование источников. Снижать разрешение значимых карт без визуального сравнения не стали.

Переход между одиночным и онлайн-режимами и изменение качества пока создают новую страницу. Обычное меню, выбор автомобиля и тестовых участков её не перезагружают.

В конфигурации сервера не найден лимит 20 Мбит/с. Реальную скорость внешнего сервера/прокси/провайдера этот локальный аудит не устанавливает. Результаты CPU-тестов не заменяют замер FPS на игровом GPU.

## Проверки

```powershell
npm run typecheck
npm test
npm run build
npm run build:server
npm run perfcheck
node --import tsx scripts/renderLoadcheck.ts
node --import tsx scripts/auditModelTextures.ts
```

Для проверки HTTP на production-сборке: `node --import tsx scripts/checkModelDelivery.ts` (требуется Caddy; параметры см. в скрипте). Клиент и сервер нужно обновлять вместе: сетевой протокол — версия 13.
