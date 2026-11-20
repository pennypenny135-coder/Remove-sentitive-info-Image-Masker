/**
 * All OCR assets (worker, WASM core, trained language data) are bundled into the app and
 * served from memory/blob: URLs – the OCR never downloads anything from a CDN.
 * This module is imported lazily (only when the user presses the OCR button).
 */
// @ts-expect-error vite ?raw import
import workerSrc from "../../node_modules/tesseract.js/dist/worker.min.js?raw";
// @ts-expect-error vite ?raw import
import coreSrc from "../../node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js?raw";
// @ts-expect-error vite ?url import
import engUrl from "../../node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url";
// @ts-expect-error vite ?url import
import chiUrl from "../../node_modules/@tesseract.js-data/chi_tra/4.0.0_best_int/chi_tra.traineddata.gz?url";

export const assets = {
  workerSrc: workerSrc as string,
  coreSrc: coreSrc as string,
  engUrl: engUrl as string,
  chiUrl: chiUrl as string,
};
