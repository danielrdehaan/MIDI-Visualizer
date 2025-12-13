import { Plugin, TFile } from 'obsidian';
import { Midi } from '@tonejs/midi';

interface PianoRollOptions {
    showNames: boolean;
    accidentals: 'sharp' | 'flat';
    viewportHeight: number;
    audioFile?: TFile;
}

interface RenderNote {
    time: number;
    duration: number;
    midi: number;
    hue: number;
}

interface MeasureInfo {
    index: number;
    startTime: number;
    duration: number;
    numerator: number;
    denominator: number;
}

export default class MidiVisualizerPlugin extends Plugin {

    async onload() {
        this.registerMarkdownCodeBlockProcessor("midi", async (source, el, ctx) => {
            const lines = source.split("\n").map(line => line.trim()).filter(line => line.length > 0);
            
            let filename = "";
            let audioFilename = "";
            let showNames = false;
            let accidentals: 'sharp' | 'flat' = 'sharp';
            let viewportHeight = 400;

            if (lines.length === 1 && !lines[0].includes(":")) {
                filename = lines[0];
            } else {
                lines.forEach(line => {
                    if (!line.includes(":")) {
                        filename = line;
                        return;
                    }
                    const parts = line.split(":");
                    const key = parts[0].trim().toLowerCase();
                    const value = parts.slice(1).join(":").trim();

                    if (key === "file") filename = value;
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

    findStartIndex(notes: RenderNote[], startTime: number): number {
        let low = 0;
        let high = notes.length - 1;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (notes[mid].time + notes[mid].duration < startTime) low = mid + 1;
            else high = mid - 1;
        }
        return low;
    }

    // --- ACCURATE TIME CONVERSION ---
    ticksToSeconds(tick: number, midi: Midi): number {
        const tempos = midi.header.tempos;
        const ppq = midi.header.ppq;
        
        if (tempos.length === 0) return (tick / ppq) * (60 / 120);

        // Find the tempo event that precedes this tick
        let i = 0;
        while (i < tempos.length - 1 && tempos[i + 1].ticks <= tick) {
            i++;
        }
        
        const tempo = tempos[i];
        const ticksSinceTempo = tick - tempo.ticks;
        const secondsPerTick = 60 / (tempo.bpm * ppq);
        
        // Time = Time at Start of Tempo + (Ticks passed * Seconds per tick)
        return tempo.time + (ticksSinceTempo * secondsPerTick);
    }

    // --- DRIFT-FREE MEASURE MAP ---
    buildMeasureMap(midi: Midi): MeasureInfo[] {
        const map: MeasureInfo[] = [];
        const ppq = midi.header.ppq;
        const timeSigs = midi.header.timeSignatures;
        
        // Find total length in ticks (use last note or arbitrary buffer)
        let totalTicks = 0;
        midi.tracks.forEach(t => {
            t.notes.forEach(n => {
                if (n.ticks + n.durationTicks > totalTicks) totalTicks = n.ticks + n.durationTicks;
            });
        });
        totalTicks += (ppq * 4 * 10); // Buffer 10 bars

        let currentTick = 0;
        let measureIndex = 0;
        let sigIndex = 0;

        let currentNum = timeSigs.length > 0 ? timeSigs[0].timeSignature[0] : 4;
        let currentDenom = timeSigs.length > 0 ? timeSigs[0].timeSignature[1] : 4;

        while (currentTick < totalTicks) {
            // Update Time Signature if needed
            // We check if a time sig event happened at or before this exact bar line
            while (sigIndex < timeSigs.length && timeSigs[sigIndex].ticks <= currentTick) {
                currentNum = timeSigs[sigIndex].timeSignature[0];
                currentDenom = timeSigs[sigIndex].timeSignature[1];
                sigIndex++;
            }

            // Calculate Measure Length in TICKS (Integers = No Drift)
            // (Numerator * 4 / Denominator) * PPQ
            const ticksPerMeasure = (currentNum * 4 / currentDenom) * ppq;
            
            // Convert exact Start/End ticks to Seconds using full Tempo Map
            const startSeconds = this.ticksToSeconds(currentTick, midi);
            const endSeconds = this.ticksToSeconds(currentTick + ticksPerMeasure, midi);
            
            map.push({
                index: measureIndex,
                startTime: startSeconds,
                duration: endSeconds - startSeconds,
                numerator: currentNum,
                denominator: currentDenom
            });

            currentTick += ticksPerMeasure;
            measureIndex++;
        }

        return map;
    }

    renderInteractivePianoRoll(midi: Midi, container: HTMLElement, options: PianoRollOptions) {
        const wrapper = container.createDiv({ cls: 'midi-roll-wrapper' });
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";

        // --- 1. SETUP DATA ---
        const allNotes: RenderNote[] = [];
        let minNote = 128;
        let maxNote = 0;

        midi.tracks.forEach((track, index) => {
            const hue = (index * 137) % 360;
            track.notes.forEach(note => {
                if (note.midi < minNote) minNote = note.midi;
                if (note.midi > maxNote) maxNote = note.midi;
                allNotes.push({ time: note.time, duration: note.duration, midi: note.midi, hue: hue });
            });
        });
        allNotes.sort((a, b) => a.time - b.time);
        minNote = Math.max(0, minNote - 2);
        maxNote = Math.min(127, maxNote + 2);
        const totalDuration = midi.duration || 1;

        // Build Accurate Grid
        const measureMap = this.buildMeasureMap(midi);

        // --- 2. AUDIO SETUP ---
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

        // --- 3. OFFSCREEN CACHE ---
        const bgCanvas = document.createElement("canvas");
        bgCanvas.width = width;
        bgCanvas.height = 128 * noteHeight;
        const bgCtx = bgCanvas.getContext("2d", { alpha: false });

        if (bgCtx) {
            bgCtx.fillStyle = "#222";
            bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
            bgCtx.lineWidth = 1;
            const noteAreaWidth = bgCanvas.width - keyWidth;

            for (let i = 0; i < 128; i++) {
                const currentMidi = 127 - i;
                const y = i * noteHeight;
                const isBlackKey = [1, 3, 6, 8, 10].includes(currentMidi % 12);
                
                if (isBlackKey) {
                    bgCtx.fillStyle = "#1a1a1a";
                    bgCtx.fillRect(keyWidth, y, noteAreaWidth, noteHeight);
                }
                bgCtx.strokeStyle = "#333";
                bgCtx.beginPath();
                bgCtx.moveTo(keyWidth, y);
                bgCtx.lineTo(bgCanvas.width, y);
                bgCtx.stroke();
                bgCtx.fillStyle = isBlackKey ? "#000" : "#fff";
                bgCtx.fillRect(0, y, keyWidth, noteHeight);
                bgCtx.strokeStyle = "#555";
                bgCtx.strokeRect(0, y, keyWidth, noteHeight);
                if (currentMidi % 12 === 0) {
                    bgCtx.fillStyle = "#000";
                    bgCtx.font = "10px sans-serif";
                    bgCtx.textAlign = "right";
                    bgCtx.textBaseline = "alphabetic";
                    const octave = Math.floor(currentMidi / 12) - 1;
                    bgCtx.fillText(`C${octave}`, keyWidth - 3, y + noteHeight - 3);
                }
            }
        }

        // --- 4. CONTROLS BAR ---
        if (audioElement) {
            const controlsBar = wrapper.createEl("div", { cls: "midi-bottom-bar" });
            Object.assign(controlsBar.style, {
                width: "100%", height: "36px", background: "#2a2a2a",
                borderTop: "1px solid #444", borderBottomLeftRadius: "4px", borderBottomRightRadius: "4px",
                display: "flex", alignItems: "center", padding: "0 10px", gap: "15px"
            });

            playBtn = controlsBar.createEl("button", { text: "▶ Play" });
            Object.assign(playBtn.style, {
                cursor: "pointer", padding: "4px 12px", background: "#444", color: "#fff",
                border: "1px solid #555", borderRadius: "3px", fontSize: "12px", fontWeight: "bold", minWidth: "60px"
            });
            playBtn.onclick = () => togglePlay();

            const volGroup = controlsBar.createEl("div");
            volGroup.style.display = "flex"; volGroup.style.alignItems = "center"; volGroup.style.gap = "5px";
            const volIcon = volGroup.createEl("span", { text: "🔊" });
            volIcon.style.fontSize = "14px"; volIcon.style.color = "#ccc"; volIcon.style.cursor = "default";
            const volSlider = volGroup.createEl("input");
            volSlider.type = "range"; volSlider.min = "0"; volSlider.max = "1"; volSlider.step = "0.01"; volSlider.value = "1";
            Object.assign(volSlider.style, { width: "80px", cursor: "pointer", height: "4px", accentColor: "#666" });
            volSlider.oninput = (e) => { if (audioElement) audioElement.volume = parseFloat((e.target as HTMLInputElement).value); };
        }

        // --- 5. STATE ---
        const noteAreaWidth = canvas.width - keyWidth;
        const minZoom = noteAreaWidth / totalDuration;
        const maxZoom = 2000;
        let zoomX = minZoom;
        
        const centerNote = (minNote + maxNote) / 2;
        const centerPixel = (127 - centerNote) * noteHeight;
        let scrollY = Math.max(0, centerPixel - (options.viewportHeight / 2));
        let scrollX = 0;
        
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

        const seekTo = (time: number) => {
            if (audioElement) {
                time = Math.max(0, Math.min(time, totalDuration));
                audioElement.currentTime = time;
            }
        };

        const applyConstraints = () => {
            zoomX = Math.max(minZoom, Math.min(zoomX, maxZoom));
            const visibleDuration = (canvas.width - keyWidth) / zoomX;
            const maxScrollX = Math.max(0, totalDuration - visibleDuration);
            scrollX = Math.max(0, Math.min(scrollX, maxScrollX));
        };

        // --- 6. RENDER LOOP ---
        const draw = () => {
            if (isPlaying && audioElement && !isDraggingRuler && !isDraggingPlayhead) {
                const playTime = audioElement.currentTime;
                const visibleDuration = (canvas.width - keyWidth) / zoomX;
                let targetScrollX = playTime - (visibleDuration / 2);
                const maxScrollX = Math.max(0, totalDuration - visibleDuration);
                targetScrollX = Math.max(0, Math.min(targetScrollX, maxScrollX));
                scrollX = targetScrollX;
            }

            // A. BACKGROUND
            const bgY = rulerHeight - scrollY;
            ctx.drawImage(bgCanvas, 0, bgY);
            if (bgY > 0) { ctx.fillStyle = "#222"; ctx.fillRect(0, 0, width, bgY); }
            if (bgY + bgCanvas.height < canvas.height) {
                ctx.fillStyle = "#222";
                ctx.fillRect(0, bgY + bgCanvas.height, width, canvas.height - (bgY + bgCanvas.height));
            }

            // B. NOTES
            const startVisibleTime = scrollX;
            const endVisibleTime = scrollX + (canvas.width / zoomX);
            let i = this.findStartIndex(allNotes, startVisibleTime);

            for (; i < allNotes.length; i++) {
                const note = allNotes[i];
                if (note.time > endVisibleTime) break;
                if (note.time + note.duration < startVisibleTime) continue;

                const x = keyWidth + (note.time - scrollX) * zoomX;
                const w = note.duration * zoomX;
                const y = ((127 - note.midi) * noteHeight) - scrollY + rulerHeight;

                if (y + noteHeight < rulerHeight || y > canvas.height) continue;

                ctx.fillStyle = `hsl(${note.hue}, 70%, 60%)`;
                ctx.strokeStyle = `hsl(${note.hue}, 70%, 30%)`;
                const drawX = Math.max(keyWidth, x);
                const drawW = Math.min(w, w - (keyWidth - x));

                if (drawW > 0) {
                    ctx.fillRect(drawX, y + 1, drawW, noteHeight - 2);
                    ctx.strokeRect(drawX, y + 1, drawW, noteHeight - 2);

                    if (options.showNames && drawW > 15) {
                        const name = this.getNoteName(note.midi, options.accidentals);
                        if (drawW > 12) {
                            const textW = ctx.measureText(name).width;
                            if (drawW > textW + 4) {
                                ctx.fillStyle = "#000";
                                ctx.font = "10px sans-serif";
                                ctx.textAlign = "left";
                                ctx.textBaseline = "middle";
                                ctx.fillText(name, drawX + 2, y + (noteHeight/2));
                            }
                        }
                    }
                }
            }

            // C. RULER
            ctx.fillStyle = "#333";
            ctx.fillRect(keyWidth, 0, noteAreaWidth, rulerHeight);
            
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            let showBeats = zoomX > 20;

            for (const m of measureMap) {
                if (m.startTime + m.duration < startVisibleTime) continue;
                if (m.startTime > endVisibleTime) break;

                const screenX = keyWidth + (m.startTime - scrollX) * zoomX;
                
                // Bar Line
                ctx.strokeStyle = "#999";
                ctx.beginPath();
                ctx.moveTo(screenX, 0);
                ctx.lineTo(screenX, rulerHeight);
                ctx.stroke();

                ctx.fillStyle = "#ccc";
                ctx.fillText((m.index + 1).toString(), screenX + 4, 4);

                ctx.save();
                ctx.strokeStyle = "#444";
                ctx.globalAlpha = 0.5;
                ctx.beginPath();
                ctx.moveTo(screenX, rulerHeight);
                ctx.lineTo(screenX, canvas.height);
                ctx.stroke();
                ctx.restore();

                if (showBeats) {
                    const beatDuration = m.duration / m.numerator;
                    for (let b = 1; b < m.numerator; b++) {
                        const beatTime = m.startTime + (b * beatDuration);
                        if (beatTime > endVisibleTime) break;
                        
                        const beatX = keyWidth + (beatTime - scrollX) * zoomX;
                        ctx.strokeStyle = "#555";
                        ctx.beginPath();
                        ctx.moveTo(beatX, rulerHeight - 10);
                        ctx.lineTo(beatX, rulerHeight);
                        ctx.stroke();
                    }
                }
            }

            // D. PLAYHEAD
            if (audioElement) {
                const playTime = audioElement.currentTime;
                const playheadX = keyWidth + (playTime - scrollX) * zoomX;

                if (playheadX >= keyWidth && playheadX <= canvas.width) {
                    ctx.strokeStyle = "#ff3333";
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(playheadX, 0);
                    ctx.lineTo(playheadX, canvas.height);
                    ctx.stroke();
                    ctx.fillStyle = "#ff3333";
                    ctx.beginPath();
                    ctx.moveTo(playheadX - 8, 0);
                    ctx.lineTo(playheadX + 8, 0);
                    ctx.lineTo(playheadX, 12);
                    ctx.fill();
                }
            }

            // E. CORNER
            ctx.fillStyle = "#222";
            ctx.fillRect(0, 0, keyWidth, rulerHeight);
            ctx.strokeStyle = "#000";
            ctx.strokeRect(0, 0, keyWidth, rulerHeight);

            if (isPlaying || audioElement) requestAnimationFrame(draw);
        };

        // --- 7. EVENT LISTENERS ---
        if (audioElement) {
            audioElement.addEventListener('ended', () => {
                isPlaying = false;
                if (playBtn) playBtn.innerText = "▶ Play";
                audioElement.currentTime = 0;
                scrollX = 0;
                requestAnimationFrame(draw);
            });
        }

        canvas.addEventListener("wheel", (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                const zoomFactor = 1.1;
                const mouseX = e.offsetX - keyWidth;
                const timeAtMouse = scrollX + (mouseX / zoomX);
                if (e.deltaY < 0) zoomX *= zoomFactor; else zoomX /= zoomFactor;
                applyConstraints();
                scrollX = timeAtMouse - (mouseX / zoomX);
            } else {
                if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) scrollX += e.deltaX / zoomX;
                else scrollY += e.deltaY;
            }
            applyConstraints();
            requestAnimationFrame(draw);
        }, { passive: false });

        let dragStartX = 0;
        let didDrag = false;
        
        canvas.addEventListener("mousedown", (e) => {
            const x = e.offsetX;
            const y = e.offsetY;
            dragStartX = x;
            didDrag = false;

            if (audioElement && y < rulerHeight + 10) {
                const playTime = audioElement.currentTime;
                const playheadX = keyWidth + (playTime - scrollX) * zoomX;
                if (Math.abs(x - playheadX) < 10) {
                    isDraggingPlayhead = true;
                    canvas.style.cursor = "ew-resize";
                    return;
                }
            }
            if (y < rulerHeight) {
                isDraggingRuler = true;
                canvas.style.cursor = "default";
            } else if (x < keyWidth) {
                isDraggingKeys = true;
                canvas.style.cursor = "ns-resize";
            } else {
                canvas.style.cursor = "grab";
            }
        });

        const onMouseMove = (e: MouseEvent) => {
            if (!isDraggingRuler && !isDraggingPlayhead && !isDraggingKeys) {
                const x = e.offsetX;
                const y = e.offsetY;
                if (audioElement && y < rulerHeight + 10) {
                    const playTime = audioElement.currentTime;
                    const playheadX = keyWidth + (playTime - scrollX) * zoomX;
                    if (Math.abs(x - playheadX) < 10) {
                        canvas.style.cursor = "pointer";
                        return;
                    }
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
                     const time = scrollX + (mouseX / zoomX);
                     seekTo(time);
                 }
            }
            else if (isDraggingRuler) {
                canvas.style.cursor = "ew-resize";
                if (Math.abs(e.movementX) > 0) scrollX -= e.movementX / zoomX;
                if (Math.abs(e.movementY) > 0) {
                    const mouseX = e.offsetX - keyWidth;
                    const timeAtMouse = scrollX + (mouseX / zoomX);
                    const zoomSensitivity = 0.01;
                    const zoomFactor = 1 + Math.abs(e.movementY * zoomSensitivity);
                    if (e.movementY > 0) zoomX *= zoomFactor; else zoomX /= zoomFactor;
                    applyConstraints();
                    scrollX = timeAtMouse - (mouseX / zoomX);
                }
            }
            else if (isDraggingKeys) scrollY -= e.movementY;

            applyConstraints();
            requestAnimationFrame(draw);
        };

        const onMouseUp = (e: MouseEvent) => {
            if (isDraggingRuler && !didDrag && audioElement) {
                const mouseX = e.offsetX - keyWidth;
                const time = scrollX + (mouseX / zoomX);
                seekTo(time);
                requestAnimationFrame(draw);
            }
            isDraggingRuler = false; isDraggingPlayhead = false; isDraggingKeys = false;
            const x = e.offsetX; const y = e.offsetY;
             if (audioElement && y < rulerHeight + 10) {
                const playTime = audioElement.currentTime;
                const playheadX = keyWidth + (playTime - scrollX) * zoomX;
                if (Math.abs(x - playheadX) < 10) canvas.style.cursor = "pointer";
                else canvas.style.cursor = "default";
             } else { canvas.style.cursor = "default"; }
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
