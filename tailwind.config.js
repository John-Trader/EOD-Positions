// Vendored Tailwind build — `npm run build:css` regenerates the committed app.css.
// index.html is the only template that carries Tailwind classes, and every class
// name there is a literal string (no runtime concatenation), so this content glob
// is complete. ledger.js emits only its own self-styled lr-* classes.
module.exports = {
    content: ['./index.html'],
    theme: { extend: {} },
    plugins: [],
};
