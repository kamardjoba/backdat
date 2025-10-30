// /lib/pricing.js
export function calcPrice({ base_price, multiplier }) {
    const p = Number(base_price) * Number(multiplier || 1);
    return Math.round(p * 100) / 100; // 2 знака
  }