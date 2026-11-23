'use strict';

// Mobile Safari ignores viewport zoom limits. Prevent page-level pinch and
// gesture zoom while preserving ordinary one-finger scrolling and input use.
document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (event) => event.preventDefault(), { passive: false });
document.addEventListener('gestureend', (event) => event.preventDefault(), { passive: false });

document.addEventListener('touchstart', (event) => {
  if (event.touches.length > 1) event.preventDefault();
}, { passive: false });

document.addEventListener('touchmove', (event) => {
  if (event.touches.length > 1) event.preventDefault();
}, { passive: false });

document.addEventListener('wheel', (event) => {
  if (event.ctrlKey || event.metaKey) event.preventDefault();
}, { passive: false });

document.addEventListener('dblclick', (event) => event.preventDefault());

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && (
    event.key === '+' || event.key === '-' || event.key === '=' ||
    event.key === '0' || event.code === 'NumpadAdd' || event.code === 'NumpadSubtract'
  )) {
    event.preventDefault();
  }
}, { passive: false });
