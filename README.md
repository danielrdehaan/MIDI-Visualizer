# Obsidian MIDI Visualizer

An Obsidian plugin that renders interactive piano roll visualizations of MIDI files directly in your notes. Sync playback with audio files to follow along with your music.



## Features

- **Interactive Piano Roll** — Visualize MIDI notes on a scrollable, zoomable canvas with color-coded tracks
- **Audio Sync** — Link an audio file to your MIDI and watch the playhead follow along in real-time
- **Tempo & Time Signature Support** — Accurate measure lines and beat markers that respect tempo changes and time signature events
- **Customizable Display** — Show note names, choose between sharps/flats, and adjust viewport height
- **Theme Support** — Automatically adapts to Obsidian's light and dark modes, updating in real-time when you switch themes
- **Intuitive Navigation**
  - Scroll horizontally/vertically with mouse wheel
  - Zoom with Ctrl/Cmd + scroll
  - Drag the ruler to pan and zoom simultaneously
  - Drag the piano keys to scroll vertically
  - Click the ruler or drag the playhead to seek

## Installation

### Manual Installation

1. Download the latest release
2. Extract the files into your vault's `.obsidian/plugins/midi-visualizer/` folder
3. Enable the plugin in Obsidian's Community Plugins settings

### From Source

```bash
git clone https://github.com/your-username/obsidian-midi-visualizer
cd obsidian-midi-visualizer
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder.

## Usage

Create a `midiviz` code block in any note and specify your MIDI file:

~~~markdown
```midiviz
midi: path/to/your/file.mid
```
~~~

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `midi` | Path to the MIDI file (relative to vault root) | *required* |
| `audio` | Path to an audio file for synchronized playback | *none* |
| `names` | Display note names on the piano roll (`true`/`false`) | `false` |
| `accidentals` | Note naming style (`sharp` or `flat`) | `sharp` |
| `height` | Viewport height in pixels | `400` |

### Examples

**Basic visualization:**

~~~markdown
```midiviz
midi: Music/beethoven-sonata.mid
```
~~~

**With audio sync and note names:**

~~~markdown
```midiviz
midi: Music/jazz-standard.mid
audio: Music/jazz-standard.mp3
names: true
accidentals: flat
height: 500
```
~~~

**Simple one-liner (legacy syntax):**

~~~markdown
```midiviz
my-song.mid
```
~~~

## Controls

| Action | Control |
|--------|---------|
| Horizontal scroll | Mouse wheel (horizontal) or vertical wheel |
| Vertical scroll | Drag piano keys or wheel over keys |
| Zoom | Ctrl/Cmd + mouse wheel |
| Pan + zoom | Drag on the ruler |
| Seek | Click ruler or drag playhead |
| Play/Pause | Click button or press Space |
| Volume | Adjust slider in control bar |

## Theming

The plugin fully supports Obsidian's light and dark modes and will update automatically when you switch themes. 

All colors are defined as CSS custom properties in `styles.css`, making it easy to customize or integrate with custom themes. The available variables include:

- `--midi-bg`, `--midi-bg-black-row` — Background colors
- `--midi-key-white`, `--midi-key-black` — Piano key colors
- `--midi-ruler-bg`, `--midi-ruler-text` — Ruler styling
- `--midi-playhead` — Playhead color
- `--midi-note-saturation`, `--midi-note-lightness` — Note color intensity

See `styles.css` for the complete list of customizable properties.

## How It Works

The plugin uses [@tonejs/midi](https://github.com/Tonejs/Midi) to parse MIDI files and renders notes to an HTML canvas. Each track is assigned a unique color based on its index. The tempo map engine accurately converts between MIDI ticks and real time, supporting files with multiple tempo changes.

## Requirements

- Obsidian v1.0.0 or higher
- MIDI files must be stored in your vault

## License

MIT License — see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Support

If you find this plugin useful, consider supporting development:

<a href="https://buymeacoffee.com/danielrdehaan">
  <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee" />
</a>

---

Made with ♪ for the Obsidian community
