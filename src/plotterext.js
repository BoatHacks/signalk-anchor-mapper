'use strict'

// Freeboard-SK plotter extension manifest (Plotter Extensions API version 1,
// Freeboard >= 3.4). Served as the 'plotterExtensions' resource while the plugin
// runs. The pages live in public/plotterext/ and are served by the server's webapp
// mount of public/ at /<package-name>/, so this adds no HTTP route of our own.

const PLUGIN_ID = 'signalk-anchor-mapper'
const RESOURCE_TYPE = 'plotterExtensions'
const BASE = `/${PLUGIN_ID}/plotterext`
const OVERLAY_ID = 'anchors'
const SOURCE_ID = 'estimates'

function buildManifest(version) {
  return {
    name: 'Anchor Mapper',
    description: 'Estimated anchor positions and swing circles of other vessels, from their AIS tracks.',
    version: String(version || '0.0.0'),
    apiVersion: '1',
    requires: ['overlays.data', 'background.iframe'],
    optional: ['actions', 'actions.overlay', 'panels.iframe', 'windows', 'nightMode'],
    background: [{ id: 'live', title: 'Anchor Mapper updates', type: 'iframe', url: `${BASE}/runtime.html` }],
    overlays: [
      {
        id: OVERLAY_ID,
        title: 'Anchored vessels',
        type: 'data',
        band: 'aboveResources',
        visible: true,
        opacity: 0.9,
        minZoom: 10,
        style: `${BASE}/style.json`,
        interactive: true,
        interactiveLayers: ['anchor-point'],
        titleProperty: 'name'
      }
    ],
    panels: [{ id: 'estimate', title: 'Anchor estimate', type: 'iframe', url: `${BASE}/estimate.html` }],
    actions: [
      {
        id: 'details',
        title: 'Anchor estimate',
        icon: 'anchor',
        default: true,
        targets: [{ kind: 'overlayFeature', overlays: [OVERLAY_ID] }],
        action: { type: 'openWindow', panel: 'estimate' }
      },
      {
        id: 'vessel',
        title: 'Anchor estimate',
        icon: 'anchor',
        targets: [{ kind: 'vessel', self: false }],
        action: { type: 'openWindow', panel: 'estimate' }
      }
    ]
  }
}

module.exports = { PLUGIN_ID, RESOURCE_TYPE, BASE, OVERLAY_ID, SOURCE_ID, buildManifest }
