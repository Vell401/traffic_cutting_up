/** Force-model and keyboard steering controls belonging exclusively to R34. */
export const R34_TUNE_FIELDS = [
  { key: 'steerAssist', label: 'R34 · автоконтрруление', min: 0, max: 1.5, step: .05 },
  { key: 'steerDamping', label: 'R34 · демпфирование рулевой рейки', min: 0, max: 1, step: .01 },
  { key: 'steerBias', label: 'R34 · усилие клавиатурного сервопривода', min: .1, max: 2, step: .01 },
  { key: 'rackRate', label: 'R34 · скорость рулевой рейки, рад/с', min: .3, max: 12, step: .1 },
  { key: 'mechanicalTrail', label: 'R34 · механический след кастера, м', min: 0, max: .2, step: .005 },
  { key: 'rackInertia', label: 'R34 · инерция рулевой рейки, кг·м²', min: .5, max: 20, step: .1 },
  { key: 'rackCentering', label: 'R34 · возвратное усилие рейки, Н·м/рад', min: 0, max: 2000, step: 10 },
  { key: 'slipRatioPeak', label: 'R34 · продольное скольжение на пике сцепления', min: .04, max: .35, step: .005 },
  { key: 'slipAnglePeak', label: 'R34 · боковое скольжение на пике (tan α)', min: .03, max: .35, step: .005 },
  { key: 'wheelInertia', label: 'R34 · инерция колеса, кг·м²', min: .5, max: 6, step: .05 },
  { key: 'cgHeight', label: 'R34 · высота центра масс, м', min: .25, max: .8, step: .01 },
  { key: 'loadLag', label: 'R34 · время переноса веса, с', min: .03, max: .4, step: .01 },
  { key: 'loadSensitivity', label: 'R34 · чувствительность шин к нагрузке', min: 0, max: .4, step: .01 },
  { key: 'turboLag', label: 'R34 · отклик турбины, с', min: .01, max: 1.2, step: .01 },
] as const;
