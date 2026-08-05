import { encodePng, decodePng } from '../../app/pngcodec.js';

export class BrowserImageCodec {
  encode(bitmap) { return encodePng(bitmap); }
  decode(bytes) { return decodePng(bytes); }
}
