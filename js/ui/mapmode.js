// Temporary compatibility export. Map ownership now lives entirely inside
// modes/maps; remove this facade after shared preview consumes a renderer
// contribution instead of importing the concrete mode.
export * from '../modes/maps/map-editor.js';
