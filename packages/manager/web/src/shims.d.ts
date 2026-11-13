/// <reference types="vite/client" />
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: Element, url: string, options?: Record<string, unknown>);
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    disconnect(): void;
  }
}
declare module '*.css';
