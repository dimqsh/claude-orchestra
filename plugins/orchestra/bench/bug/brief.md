#B-bug Preserve zero quantities
Fix subtotal in basket.mjs: a missing quantity means one, but zero means zero. Prices are integer cents; discount is a fraction. Keep the API.
