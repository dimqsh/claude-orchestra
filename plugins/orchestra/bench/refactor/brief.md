#B-refactor Share line pricing
Refactor duplicated line pricing from cart.mjs into an exported lineTotal(item) in pricing.mjs. Both total and receipt must use that shared function. Preserve public APIs, rounding per line, optional discount, receipt formatting and empty-cart behavior.
