module.exports = {
  plugins: [
    require("tailwindcss")(),
    require("./scripts/build/postcss-interface-font-scale.cjs")(),
    require("autoprefixer")(),
  ],
};
