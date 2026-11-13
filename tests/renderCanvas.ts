/** Canvas boundary for real procedural-material tests without a browser. */
export const renderDocument = {
  createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => {} }) }),
};
