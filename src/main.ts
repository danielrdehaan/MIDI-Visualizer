import { Plugin, TFile } from 'obsidian';
import { Midi } from '@tonejs/midi';

interface PianoRollOptions {
    showNames: boolean;
    accidentals: 'sharp' | 'flat';
    viewportHeight: number;
    audioFile?: TFile;
}

interface RenderNote {
    tick: number;
    durationTicks: number;
    midi: number;
    hue: number;
}

interface MeasureInfo {
    index: number;
    tick: number;
    numerator: number;
    denominator: number;
}

interface TempoEvent {
    ticks: number;
    bpm: number;
    time: number;
}

export default class MidiVisualizerPlugin extends Plugin {

    async onload() {
        // CHANGED: "midi" -> "midiviz" to avoid conflicts
        this.registerMarkdownCodeBlockProcessor("midiviz", async (source, el, ctx) => {
            const lines = source.split("\n").map(line => line.trim()).filter(line => line.length > 0);
            
            let filename = "";
            let audioFilename = "";
            let showNames = false;
            let accidentals: 'sharp' | 'flat' = 'sharp';
            let viewportHeight = 400;

            // Legacy support: if line 1 has no colon, assume it's the midi file
            if (lines.length === 1 && !lines[0].includes(":")) {
                filename = lines[0];
            } else {
                lines.forEach(line => {
                    if (!line.includes(":")) {
                        // If we find a stray line, assume midi file if not set yet
                        if (!filename) filename = line;
                        return;
                    }
                    const parts = line.split(":");
                    const key = parts[0].trim().toLowerCase();
                    const value = parts.slice(1).join(":").trim();

                    // CHANGED: "file" -> "midi"
                    if (key === "midi" || key === "file") filename = value;
                    if (key === "audio") audioFilename = value;
                    if (key === "names") showNames = (value.toLowerCase() === "true");
                    if (key === "accidentals") accidentals = (value.toLowerCase().startsWith("flat")) ? 'flat' : 'sharp';
                    if (key === "height") viewportHeight = parseInt(value) || 400;
                });
            }

            const midiFile = this.app.metadataCache.getFirstLinkpathDest(filename, ctx.sourcePath);
            let audioFile: TFile | undefined;
            if (audioFilename) {
                const foundAudio = this.app.metadataCache.getFirstLinkpathDest(audioFilename, ctx.sourcePath);
                if (foundAudio instanceof TFile) audioFile = foundAudio;
            }
            
            if (!midiFile || !(midiFile instanceof TFile)) {
                el.createEl("div", { text: `⚠️ MIDI file not found: ${filename}` });
                return;
            }

            try {
                const arrayBuffer = await this.app.vault.readBinary(midiFile);
                const midi = new Midi(arrayBuffer);
                this.renderInteractivePianoRoll(midi, el, { showNames, accidentals, viewportHeight, audioFile });
            } catch (error) {
                console.error(error);
                el.createEl("div", { text: `Error parsing MIDI: ${error.message}` });
            }
        });
    }

    getNoteName(midi: number, type: 'sharp' | 'flat'): string {
        const sharps = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const flats = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
        const names = type === 'flat' ? flats : sharps;
        return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
    }

    findStartIndex(notes: RenderNote[], startTick: number): number {
        let low = 0;
        let high = notes.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (notes[mid].tick + notes[mid].durationTicks < startTick) low = mid + 1;
            else high = mid - 1;
        }
        return low;
    }

    // --- TEMPO MAP ENGINE ---
    private customTempoMap: TempoEvent[] = [];
    private ppq: number = 480;

    recalculateTempoMap(midi: Midi) {
        this.ppq = midi.header.ppq;
        const rawTempos = midi.header.tempos;
        rawTempos.sort((a, b) => a.ticks - b.ticks);

        this.customTempoMap = [];
        
        if (rawTempos.length === 0 || rawTempos[0].ticks > 0) {
            this.customTempoMap.push({ ticks: 0, bpm: 120, time: 0 });
        }

        let currentTime = 0;
        let lastTicks = 0;
        let lastBpm = (rawTempos.length > 0 && rawTempos[0].ticks === 0) ? rawTempos[0].bpm : 120;

        for (const t of rawTempos) {
            if (t.ticks === 0) { lastBpm = t.bpm; continue; }

            const deltaTicks = t.ticks - lastTicks;
            const secondsPerTick = 60 / (lastBpm * this.ppq);
            currentTime += deltaTicks * secondsPerTick;

            this.customTempoMap.push({
                ticks: t.ticks,
                bpm: t.bpm,
                time: currentTime
            });

            lastTicks = t.ticks;
            lastBpm = t.bpm;
        }
    }

    secondsToTicks(time: number): number {
        let low = 0;
        let high = this.customTempoMap.length - 1;
        let idx = 0;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (this.customTempoMap[mid].time <= time) {
                idx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        const event = this.customTempoMap[idx];
        const timeDelta = time - event.time;
        const secondsPerTick = 60 / (event.bpm * this.ppq);
        return event.ticks + (timeDelta / secondsPerTick);
    }

    ticksToSeconds(tick: number): number {
        let low = 0;
        let high = this.customTempoMap.length - 1;
        let idx = 0;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (this.customTempoMap[mid].ticks <= tick) {
                idx = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        const event = this.customTempoMap[idx];
        const delta = tick - event.ticks;
        const secondsPerTick = 60 / (event.bpm * this.ppq);
        return event.time + (delta * secondsPerTick);
    }

    renderInteractivePianoRoll(midi: Midi, container: HTMLElement, options: PianoRollOptions) {
        const wrapper = container.createDiv({ cls: 'midi-roll-wrapper' });
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";

        // Helper to read CSS variables from the wrapper
        const getColor = (varName: string, fallback: string): string => {
            const value = getComputedStyle(wrapper).getPropertyValue(varName).trim();
            return value || fallback;
        };

        // 1. Build Data
        this.recalculateTempoMap(midi);

        const allNotes: RenderNote[] = [];
        let minNote = 128;
        let maxNote = 0;
        let totalTicks = 0;

        midi.tracks.forEach((track, index) => {
            const hue = (index * 137) % 360;
            track.notes.forEach(note => {
                if (note.midi < minNote) minNote = note.midi;
                if (note.midi > maxNote) maxNote = note.midi;
                const endTick = note.ticks + note.durationTicks;
                if (endTick > totalTicks) totalTicks = endTick;
                
                allNotes.push({
                    tick: note.ticks,
                    durationTicks: note.durationTicks,
                    midi: note.midi,
                    hue: hue
                });
            });
        });
        allNotes.sort((a, b) => a.tick - b.tick);
        minNote = Math.max(0, minNote - 2);
        maxNote = Math.min(127, maxNote + 2);
        
        const ppq = midi.header.ppq;
        const songEndTick = totalTicks;
        totalTicks += ppq * 4; // Visual buffer

        // 2. Build Grid
        const measureMap: MeasureInfo[] = [];
        const timeSigs = midi.header.timeSignatures;
        if (timeSigs.length === 0) timeSigs.push({ ticks: 0, timeSignature: [4, 4] } as any);

        let measureIndex = 0;
        for (let i = 0; i < timeSigs.length; i++) {
            const currentSig = timeSigs[i];
            const nextSig = timeSigs[i + 1];
            const startTick = currentSig.ticks;
            const endTick = nextSig ? nextSig.ticks : totalTicks;
            const num = currentSig.timeSignature[0];
            const denom = currentSig.timeSignature[1];
            const ticksPerMeasure = (num * 4 / denom) * this.ppq;

            let cursor = startTick;
            while (cursor < endTick) {
                measureMap.push({
                    index: measureIndex++,
                    tick: cursor,
                    numerator: num,
                    denominator: denom
                });
                cursor += ticksPerMeasure;
            }
        }

        // 3. Audio & UI
        let audioElement: HTMLAudioElement | null = null;
        let isPlaying = false;
        let playBtn: HTMLElement | null = null;

        if (options.audioFile) {
            audioElement = new Audio(this.app.vault.getResourcePath(options.audioFile));
            audioElement.loop = false;
            audioElement.volume = 1.0;
        }

        const keyWidth = 40;
        const rulerHeight = 30;
        const noteHeight = 14;

        const canvas = wrapper.createEl("canvas", { cls: 'midi-roll-canvas' });
        const width = container.clientWidth > 0 ? container.clientWidth : 700;
        canvas.width = width;
        canvas.height = options.viewportHeight;
        canvas.style.height = `${options.viewportHeight}px`;
        canvas.style.userSelect = "none";
        canvas.style.display = "block";
        
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return;

        // 4. Offscreen Background
        const bgCanvas = document.createElement("canvas");
        bgCanvas.width = width;
        bgCanvas.height = 128 * noteHeight;
        const bgCtx = bgCanvas.getContext("2d", { alpha: false });
        
        // Theme colors object - will be updated on theme change
        let colors = {
            bg: '', bgBlackRow: '', gridLine: '', keyWhite: '', keyBlack: '',
            keyBorder: '', keyLabel: '', rulerBg: '', rulerLine: '', rulerText: '',
            rulerBeat: '', rulerCorner: '', gridLineMeasure: '', playhead: '',
            noteSaturation: '', noteLightness: '', noteLabel: '',
        };
        
        // Function to read all theme colors
        const updateColors = () => {
            colors = {
                bg: getColor('--midi-bg', '#222'),
                bgBlackRow: getColor('--midi-bg-black-row', '#1a1a1a'),
                gridLine: getColor('--midi-grid-line', '#333'),
                keyWhite: getColor('--midi-key-white', '#fff'),
                keyBlack: getColor('--midi-key-black', '#000'),
                keyBorder: getColor('--midi-key-border', '#555'),
                keyLabel: getColor('--midi-key-label', '#000'),
                rulerBg: getColor('--midi-ruler-bg', '#333'),
                rulerLine: getColor('--midi-ruler-line', '#999'),
                rulerText: getColor('--midi-ruler-text', '#ccc'),
                rulerBeat: getColor('--midi-ruler-beat', '#555'),
                rulerCorner: getColor('--midi-ruler-corner', '#222'),
                gridLineMeasure: getColor('--midi-grid-line-measure', '#444'),
                playhead: getColor('--midi-playhead', '#ff3333'),
                noteSaturation: getColor('--midi-note-saturation', '70%'),
                noteLightness: getColor('--midi-note-lightness', '60%'),
                noteLabel: getColor('--midi-note-label', '#000'),
            };
        };
        
        // Function to redraw the background canvas with current colors
        const redrawBackground = () => {
            if (!bgCtx) return;
            bgCtx.fillStyle = colors.bg;
            bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
            bgCtx.lineWidth = 1;
            const noteAreaWidth = bgCanvas.width - keyWidth;
            for (let i = 0; i < 128; i++) {
                const currentMidi = 127 - i;
                const y = i * noteHeight;
                const isBlackKey = [1, 3, 6, 8, 10].includes(currentMidi % 12);
                if (isBlackKey) {
                    bgCtx.fillStyle = colors.bgBlackRow;
                    bgCtx.fillRect(keyWidth, y, noteAreaWidth, noteHeight);
                }
                bgCtx.strokeStyle = colors.gridLine;
                bgCtx.beginPath(); bgCtx.moveTo(keyWidth, y); bgCtx.lineTo(bgCanvas.width, y); bgCtx.stroke();
                bgCtx.fillStyle = isBlackKey ? colors.keyBlack : colors.keyWhite;
                bgCtx.fillRect(0, y, keyWidth, noteHeight);
                bgCtx.strokeStyle = colors.keyBorder;
                bgCtx.strokeRect(0, y, keyWidth, noteHeight);
                if (currentMidi % 12 === 0) {
                    bgCtx.fillStyle = colors.keyLabel;
                    bgCtx.font = "10px sans-serif";
                    bgCtx.textAlign = "right";
                    bgCtx.textBaseline = "alphabetic";
                    const octave = Math.floor(currentMidi / 12) - 1;
                    bgCtx.fillText(`C${octave}`, keyWidth - 3, y + noteHeight - 3);
                }
            }
        };
        
        // Initial color read and background draw
        updateColors();
        redrawBackground();
        
        // Watch for theme changes on document.body
        const themeObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.attributeName === 'class') {
                    updateColors();
                    redrawBackground();
                    requestAnimationFrame(draw);
                    break;
                }
            }
        });
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        
        // Register cleanup for when the element is removed from DOM
        this.register(() => themeObserver.disconnect());

        // 5. Controls UI
        if (audioElement) {
            const controlsBar = wrapper.createEl("div", { cls: "midi-bottom-bar" });
            playBtn = controlsBar.createEl("button", { text: "▶ Play" });
            playBtn.onclick = () => togglePlay();
            const volGroup = controlsBar.createEl("div", { cls: "midi-volume-group" });
            volGroup.createEl("span", { text: "🔊", cls: "midi-volume-icon" });
            const volSlider = volGroup.createEl("input", { cls: "midi-volume-slider" });
            volSlider.type = "range"; volSlider.min = "0"; volSlider.max = "1"; volSlider.step = "0.01"; volSlider.value = "1";
            volSlider.oninput = (e) => { if (audioElement) audioElement.volume = parseFloat((e.target as HTMLInputElement).value); };
        }

        // 6. View State
        const noteAreaWidth = canvas.width - keyWidth;
        const minZoom = noteAreaWidth / songEndTick;
        // Default Zoom: Show roughly 16 beats (4 bars of 4/4) or fit song if smaller
        const readableTicks = ppq * 4 * 4;
        const readableZoom = noteAreaWidth / readableTicks;
        // Start closer, but not closer than 2.0, and not further than minZoom
        let zoomX = Math.max(minZoom, Math.min(readableZoom, 2.0));
        const maxZoom = 5.0;
        
        const centerNote = (minNote + maxNote) / 2;
        const centerPixel = (127 - centerNote) * noteHeight;
        let scrollY = Math.max(0, centerPixel - (options.viewportHeight / 2));
        let scrollTick = 0;
        
        let isDraggingRuler = false;
        let isDraggingPlayhead = false;
        let isDraggingKeys = false;

        const togglePlay = () => {
            if (!audioElement) return;
            if (isPlaying) {
                audioElement.pause();
                isPlaying = false;
                if (playBtn) playBtn.innerText = "▶ Play";
            } else {
                audioElement.play();
                isPlaying = true;
                if (playBtn) playBtn.innerText = "❚❚ Pause";
            }
        };

        const seekTo = (tick: number) => {
            if (audioElement) {
                const time = this.ticksToSeconds(tick);
                audioElement.currentTime = Math.max(0, time);
            }
        };

        const applyConstraints = () => {
            zoomX = Math.max(minZoom, Math.min(zoomX, maxZoom));
            const visibleTicks = (canvas.width - keyWidth) / zoomX;
            const maxScroll = Math.max(0, songEndTick - visibleTicks);
            scrollTick = Math.max(0, Math.min(scrollTick, maxScroll));
        };

        // --- RENDER LOOP ---
        const draw = () => {
            if (isPlaying && audioElement && !isDraggingRuler && !isDraggingPlayhead) {
                const playTick = this.secondsToTicks(audioElement.currentTime);
                const visibleTicks = (canvas.width - keyWidth) / zoomX;
                let targetScroll = playTick - (visibleTicks / 2);
                const maxScroll = Math.max(0, songEndTick - visibleTicks);
                scrollTick = Math.max(0, Math.min(targetScroll, maxScroll));
            }

            const bgY = (rulerHeight - scrollY) | 0;
            ctx.drawImage(bgCanvas, 0, bgY);
            if (bgY > 0) { ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, width, bgY); }
            if (bgY + bgCanvas.height < canvas.height) {
                ctx.fillStyle = colors.bg;
                ctx.fillRect(0, bgY + bgCanvas.height, width, canvas.height - (bgY + bgCanvas.height));
            }

            const startTick = scrollTick;
            const endTick = scrollTick + (canvas.width / zoomX);

            let i = this.findStartIndex(allNotes, startTick);
            let currentHue = -1;

            for (; i < allNotes.length; i++) {
                const note = allNotes[i];
                if (note.tick > endTick) break;
                if (note.tick + note.durationTicks < startTick) continue;

                const x = (keyWidth + (note.tick - scrollTick) * zoomX) | 0;
                const w = (note.durationTicks * zoomX);
                const y = (((127 - note.midi) * noteHeight) - scrollY + rulerHeight) | 0;

                if (y + noteHeight < rulerHeight || y > canvas.height) continue;

                if (note.hue !== currentHue) {
                    ctx.fillStyle = `hsl(${note.hue}, ${colors.noteSaturation}, ${colors.noteLightness})`;
                    currentHue = note.hue;
                }

                const drawX = Math.max(keyWidth, x);
                let drawW = Math.max(1, w) | 0; // Ensure at least 1px width
                
                if (drawW > 2) {
                    drawW = Math.min(drawW, drawW - (keyWidth - x));
                    if (drawW > 2) drawW -= 1;
                }

                if (drawW > 0) {
                    ctx.fillRect(drawX, y + 1, drawW, noteHeight - 2);
                    if (options.showNames && drawW > 16) {
                        const name = this.getNoteName(note.midi, options.accidentals);
                        if (drawW > 14) {
                            ctx.save();
                            ctx.fillStyle = colors.noteLabel;
                            ctx.font = "10px sans-serif";
                            ctx.textAlign = "left";
                            ctx.textBaseline = "middle";
                            ctx.fillText(name, drawX + 2, y + (noteHeight/2));
                            ctx.restore();
                            currentHue = -1;
                        }
                    }
                }
            }

            ctx.fillStyle = colors.rulerBg;
            ctx.fillRect(keyWidth, 0, noteAreaWidth, rulerHeight);
            ctx.textAlign = "left"; ctx.textBaseline = "top";
            
            const showBeats = (ppq * zoomX) > 20;

            for (const m of measureMap) {
                if (m.tick > endTick) break;
                const measureDuration = (m.numerator * 4 / m.denominator) * ppq;
                if (m.tick + measureDuration < startTick) continue;

                const screenX = (keyWidth + (m.tick - scrollTick) * zoomX) | 0;
                
                if (screenX >= keyWidth) {
                    ctx.strokeStyle = colors.rulerLine;
                    ctx.beginPath(); ctx.moveTo(screenX, 0); ctx.lineTo(screenX, rulerHeight); ctx.stroke();
                    ctx.fillStyle = colors.rulerText;
                    ctx.fillText((m.index + 1).toString(), screenX + 4, 4);
                }
                
                if (screenX >= keyWidth) {
                    ctx.save();
                    ctx.strokeStyle = colors.gridLineMeasure; ctx.globalAlpha = 0.5;
                    ctx.beginPath(); ctx.moveTo(screenX, rulerHeight); ctx.lineTo(screenX, canvas.height); ctx.stroke();
                    ctx.restore();
                }

                if (showBeats) {
                    const beatSize = (ppq * 4) / m.denominator;
                    for (let b = 1; b < m.numerator; b++) {
                        const beatTick = m.tick + (b * beatSize);
                        if (beatTick > endTick) break;
                        const beatX = (keyWidth + (beatTick - scrollTick) * zoomX) | 0;
                        if (beatX >= keyWidth) {
                            ctx.strokeStyle = colors.rulerBeat;
                            ctx.beginPath(); ctx.moveTo(beatX, rulerHeight - 10); ctx.lineTo(beatX, rulerHeight); ctx.stroke();
                        }
                    }
                }
            }

            if (audioElement) {
                const playTick = this.secondsToTicks(audioElement.currentTime);
                const playheadX = (keyWidth + (playTick - scrollTick) * zoomX) | 0;

                if (playheadX >= keyWidth && playheadX <= canvas.width) {
                    ctx.strokeStyle = colors.playhead; ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.moveTo(playheadX, 0); ctx.lineTo(playheadX, canvas.height); ctx.stroke();
                    ctx.fillStyle = colors.playhead;
                    ctx.beginPath(); ctx.moveTo(playheadX - 8, 0); ctx.lineTo(playheadX + 8, 0); ctx.lineTo(playheadX, 12); ctx.fill();
                }
            }

            ctx.fillStyle = colors.rulerCorner; ctx.fillRect(0, 0, keyWidth, rulerHeight);
            ctx.strokeStyle = colors.keyBlack; ctx.strokeRect(0, 0, keyWidth, rulerHeight);

            if (isPlaying || audioElement) requestAnimationFrame(draw);
        };

        if (audioElement) {
            audioElement.addEventListener('ended', () => {
                isPlaying = false;
                if (playBtn) playBtn.innerText = "▶ Play";
                audioElement.currentTime = 0;
                scrollTick = 0;
                requestAnimationFrame(draw);
            });
        }

        canvas.addEventListener("wheel", (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                const zoomFactor = 1.1;
                const mouseX = e.offsetX - keyWidth;
                const tickAtMouse = scrollTick + (mouseX / zoomX);
                if (e.deltaY < 0) zoomX *= zoomFactor; else zoomX /= zoomFactor;
                applyConstraints();
                scrollTick = tickAtMouse - (mouseX / zoomX);
            } else {
                if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) scrollTick += e.deltaX / zoomX;
                else scrollY += e.deltaY;
            }
            applyConstraints();
            requestAnimationFrame(draw);
        }, { passive: false });

        let dragStartX = 0;
        let didDrag = false;
        
        canvas.addEventListener("mousedown", (e) => {
            const x = e.offsetX; const y = e.offsetY;
            dragStartX = x; didDrag = false;

            if (audioElement && y < rulerHeight + 10) {
                const playTick = this.secondsToTicks(audioElement.currentTime);
                const playheadX = (keyWidth + (playTick - scrollTick) * zoomX) | 0;
                if (Math.abs(x - playheadX) < 10) {
                    isDraggingPlayhead = true; canvas.style.cursor = "ew-resize"; return;
                }
            }
            if (y < rulerHeight) { isDraggingRuler = true; canvas.style.cursor = "default"; }
            else if (x < keyWidth) { isDraggingKeys = true; canvas.style.cursor = "ns-resize"; }
            else { canvas.style.cursor = "grab"; }
        });

        const onMouseMove = (e: MouseEvent) => {
            if (!isDraggingRuler && !isDraggingPlayhead && !isDraggingKeys) {
                const x = e.offsetX; const y = e.offsetY;
                if (audioElement && y < rulerHeight + 10) {
                    const playTick = this.secondsToTicks(audioElement.currentTime);
                    const playheadX = (keyWidth + (playTick - scrollTick) * zoomX) | 0;
                    if (Math.abs(x - playheadX) < 10) { canvas.style.cursor = "pointer"; return; }
                }
                if (y < rulerHeight) canvas.style.cursor = "default";
                else if (x < keyWidth) canvas.style.cursor = "ns-resize";
                else canvas.style.cursor = "default";
                return;
            }

            if (Math.abs(e.offsetX - dragStartX) > 3) didDrag = true;

            if (isDraggingPlayhead) {
                 if (audioElement) {
                     const mouseX = e.offsetX - keyWidth;
                     const tick = scrollTick + (mouseX / zoomX);
                     seekTo(tick);
                 }
            }
            else if (isDraggingRuler) {
                canvas.style.cursor = "ew-resize";
                if (Math.abs(e.movementX) > 0) scrollTick -= e.movementX / zoomX;
                if (Math.abs(e.movementY) > 0) {
                    const mouseX = e.offsetX - keyWidth;
                    const tickAtMouse = scrollTick + (mouseX / zoomX);
                    const zoomFactor = 1 + Math.abs(e.movementY * 0.01);
                    if (e.movementY > 0) zoomX *= zoomFactor; else zoomX /= zoomFactor;
                    applyConstraints();
                    scrollTick = tickAtMouse - (mouseX / zoomX);
                }
            }
            else if (isDraggingKeys) scrollY -= e.movementY;

            applyConstraints();
            requestAnimationFrame(draw);
        };

        const onMouseUp = (e: MouseEvent) => {
            if (isDraggingRuler && !didDrag && audioElement) {
                const mouseX = e.offsetX - keyWidth;
                const tick = scrollTick + (mouseX / zoomX);
                seekTo(tick);
                requestAnimationFrame(draw);
            }
            isDraggingRuler = false; isDraggingPlayhead = false; isDraggingKeys = false;
            canvas.style.cursor = "default";
        };

        canvas.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);

        container.addEventListener("mouseenter", () => container.focus());
        canvas.tabIndex = 0;
        canvas.addEventListener("keydown", (e) => {
            if (e.code === "Space") { e.preventDefault(); togglePlay(); }
        });

        applyConstraints();
        requestAnimationFrame(draw);
    }

    onunload() { }
}
