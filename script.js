/* Bridge Physic - Final Version mit korrigierter Physik, Klick-zu-Verbinden, 
   korrigierter 1:1 Skalierung (kein Zoom), zentralen Slider-Einstellungen und Rechtsklick-Löschen */
(() => {
    'use strict';
    
    // --- Konfiguration (Werte werden später von Slidern überschrieben) ---
    const CFG = { 
        CANVAS_W: 1280, CANVAS_H: 720, 
        GRAVITY: 1600,             // Konfigurierbar
        NODE_R: 8, LINE_W: 4, 
        SUBSTEPS: 4,               // Konfigurierbar
        CONSTRAINT_PASSES: 6,      // Konfigurierbar
        BREAK_THRESHOLD_BASE: 180, // Konfigurierbar
        UNDO_LIMIT: 600, SAVE_KEY: 'bridge_physic_v11_final', 
        NODE_HIT_R: 16,
        CHAOS_SUBSTEPS: 12, 
        CHAOS_FORCE_MULT: 5000,
        PLATFORM_COLOR: '#422c2a',
        GOAL_R: 42,
    };
    
    // --- Globaler Zustand ---
    const State = {
        particles: [], constraints: [], platforms: [], goal: null,
        mode: 'build', buildMode: 'goal', 
        editMode: 'move', 
        constraintType: 'rigid', 
        selected: null, 
        dragged: null,
        draggedPlatform: null, 
        mouse: { x: 0, y: 0, isDown: false, xStart: 0, yStart: 0, xScreen: 0, yScreen: 0, xPrev: 0, yPrev: 0 },
        running: false, win: false, fx: [], undo: [], redo: [], 
        theme: 'neon', 
        useBagMode: false, 
        useChaosMode: false, 
        worldW: CFG.CANVAS_W, worldH: CFG.CANVAS_H,
        debug: { 
            showFPS: false, 
            showBoundingBoxes: false, 
            showForceVectors: false, 
            lastFrameTime: 0, 
            fpsHistory: Array(60).fill(0) 
        }
    };

    // --- DOM-Referenzen & Hilfsfunktionen ---
    const $id = (id) => document.getElementById(id);
    const canvas = $id('game-canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const btnPlay = $id('btn-play');
    const modeText = $id('mode-text');
    const floorY = CFG.CANVAS_H - 10;
    const now = () => performance.now();
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const uid = (n = 6) => Math.random().toString(36).slice(2, 2 + n);
    const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

    // --- Slider- und Konfigurationsverwaltung ---
    function applySliderConfig() {
        CFG.GRAVITY = parseFloat($id('slider-gravity').value);
        CFG.SUBSTEPS = parseInt($id('slider-substeps').value);
        CFG.CONSTRAINT_PASSES = parseInt($id('slider-constraint-passes').value);
        CFG.BREAK_THRESHOLD_BASE = parseFloat($id('slider-break-threshold').value);

        $id('val-gravity').textContent = CFG.GRAVITY;
        $id('val-substeps').textContent = CFG.SUBSTEPS;
        $id('val-constraint-passes').textContent = CFG.CONSTRAINT_PASSES;
        $id('val-break-threshold').textContent = CFG.BREAK_THRESHOLD_BASE;

        // Bruch-Thresholds für existierende Constraints neu berechnen (optional, aber gut für Konsistenz)
        for (const c of State.constraints) {
            const max_length = 300; 
            const normalized_r = clamp(c.rest, 0, max_length) / max_length;
            const strength_mult = 1.0 + (1 - normalized_r) * 1.5; 
            c.break_threshold = CFG.BREAK_THRESHOLD_BASE * strength_mult;
        }
    }

    function setupSliderListeners() {
        const sliders = [
            'slider-gravity', 'slider-substeps', 'slider-constraint-passes', 'slider-break-threshold'
        ];
        sliders.forEach(id => {
            $id(id).addEventListener('input', applySliderConfig);
        });
        $id('btn-settings').addEventListener('click', () => $id('settings-overlay').style.display = 'flex');
        $id('settings-close').addEventListener('click', () => $id('settings-overlay').style.display = 'none');
        
        applySliderConfig(); // Initialen Zustand setzen
    }

    // --- Canvas, Skalierung & Koordinatentransformation (Korrekt 1:1) ---
    function resizeCanvas() {
        const maxW = Math.min(CFG.CANVAS_W, window.innerWidth - 40);
        const cssW = Math.max(320, maxW);
        const cssH = Math.round(CFG.CANVAS_H * (cssW / CFG.CANVAS_W)); 
        const DPR = Math.min(window.devicePixelRatio || 1, 2);
        
        canvas.width = Math.round(cssW * DPR);
        canvas.height = Math.round(cssH * DPR);
        canvas.style.width = cssW + 'px';
        canvas.style.height = cssH + 'px';
        
        State.worldW = CFG.CANVAS_W; 
        State.worldH = CFG.CANVAS_H;
        
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0); 
    }
    window.addEventListener('resize', resizeCanvas);
    
    function screenPosToWorld(e) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
        const clientY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
        
        const xScreen = clientX - rect.left;
        const yScreen = clientY - rect.top;

        const scaleX = CFG.CANVAS_W / rect.width;
        const scaleY = CFG.CANVAS_H / rect.height;
        
        const xWorld = xScreen * scaleX;
        const yWorld = yScreen * scaleY;
        
        State.mouse.xScreen = xScreen;
        State.mouse.yScreen = yScreen;
        
        return { x: xWorld, y: yWorld };
    }
    
    // --- Partikel und Constraints ---
    function makeParticle(x, y, r = CFG.NODE_R) {
        return { x, y, px: x, py: y, r, pinned: false, color: '#00ffd6', id: uid(), forceX: 0, forceY: 0 }; 
    }
    function addParticle(x, y) { const p = makeParticle(x, y); State.particles.push(p); return p; }
    
    function addConstraint(a, b) { 
        if (!a || !b || a === b) return null;
        for (const c of State.constraints) if ((c.a === a && c.b === b) || (c.a === b && c.b === a)) return null; 
        const r = dist(a.x, a.y, b.x, b.y);
        
        const max_length = 300; 
        const normalized_r = clamp(r, 0, max_length) / max_length;
        const strength_mult = 1.0 + (1 - normalized_r) * 1.5; 
        const break_threshold = CFG.BREAK_THRESHOLD_BASE * strength_mult;

        const o = { a, b, rest: r, stiff: 1, broken: false, break_threshold, type: State.constraintType, id: uid(), tension: 0 }; 
        State.constraints.push(o); return o;
    }

    // --- Physik ---
    function integrateVerlet(dt) {
        const g = State.useChaosMode ? (Math.random() * CFG.GRAVITY * 1.5) : CFG.GRAVITY;
        for (const p of State.particles) {
            if (p.pinned) continue;
            
            // Dämpfung (Stabilität)
            const damping = State.dragged === p ? 1.0 : (State.running ? 0.995 : 0.95);
            const vx = (p.x - p.px) * damping; 
            const vy = (p.y - p.py) * damping; 
            
            // Beschleunigung durch Schwerkraft (korrigiert: g * dt * dt)
            const gravity_force = (g * dt * dt);
            
            const nx = p.x + vx;
            const ny = p.y + vy + gravity_force; 
            
            p.forceX = 0; 
            p.forceY = gravity_force; 
            
            p.px = p.x; p.py = p.y;
            p.x = nx; p.y = ny;
        }
    }

    function satisfyConstraints() {
        for (let pass = 0; pass < CFG.CONSTRAINT_PASSES; pass++) {
            for (const c of State.constraints) {
                if (c.broken) { c.tension = 0; continue; }
                const a = c.a, b = c.b;
                const dx = b.x - a.x, dy = b.y - a.y;
                const d = Math.hypot(dx, dy) || 1e-6;
                const diff = (d - c.rest);
                const inv_d = 1.0 / d;
                
                c.tension = Math.abs(diff);

                if (c.type === 'cable' && d <= c.rest) continue; 
                if (c.type === 'rod' && d >= c.rest) continue;   

                const inv = 0.5 * c.stiff * (diff * inv_d);
                const mx = dx * inv;
                const my = dy * inv;

                // Positionswiederherstellung
                if (!a.pinned) { a.x += mx; a.y += my; } 
                if (!b.pinned) { b.x -= mx; b.y -= my; } 
                
                // Bruch-Logik (basiert auf Geschwindigkeit/Beschleunigung)
                if (State.running) {
                    // Berechnung des relativen Abstands *nach* der Constraint-Lösung
                    // Dies ist oft stabiler als nur die Geschwindigkeit davor
                    const relDist = dist(a.x, a.y, b.x, b.y);
                    const force = Math.abs(relDist - c.rest); 
                    
                    if (force > c.break_threshold * 0.05) { // Empfindlichkeit angepasst
                        c.broken = true;
                        spawnFX((a.x + b.x) / 2, (a.y + b.y) / 2, '#ff6677', 12);
                    }
                }
            }
            resolveCollisions();
        }
    }

    function resolveCollisions() { 
        for (const p of State.particles) {
            if (p.pinned) continue;

            // 1. Kollision mit Boden
            if (p.y + p.r >= floorY) {
                const dy = (p.y + p.r) - floorY;
                p.y -= dy;
                // Prell-Effekt: p.px = p.x; p.py = p.y;
                // Für Stabilität:
                p.px = p.x; 
                p.py = p.y;
            }

            // 2. Kollision mit Plattformen
            for (const pl of State.platforms) {
                const halfW = pl.w / 2;
                const halfH = pl.h / 2;
                const cx = pl.x + halfW;
                const cy = pl.y + halfH;

                const dx = p.x - cx;
                const dy = p.y - cy;

                const minX = halfW + p.r;
                const minY = halfH + p.r;

                if (Math.abs(dx) < minX && Math.abs(dy) < minY) {
                    const overX = minX - Math.abs(dx);
                    const overY = minY - Math.abs(dy);
                    
                    if (overX < overY) {
                        const sign = dx > 0 ? 1 : -1;
                        p.x += overX * sign;
                    } else {
                        const sign = dy > 0 ? 1 : -1;
                        p.y += overY * sign;
                    }
                    p.px = p.x; p.py = p.y; 
                }
            }
        }
    }

    function applyWind(dt) { 
        const windForce = State.useChaosMode ? CFG.CHAOS_FORCE_MULT : 800;
        const f = windForce * dt * dt;
        for (const p of State.particles) {
            if (p.pinned) continue;
            p.x += f;
        }
    }

    function createPlatform(x, y, w, h, opts = {}) {
        return { 
            x, y, w, h, 
            type: opts.type || 'static', 
            range: opts.range || 0, 
            speed: opts.speed || 0, 
            angle: opts.angle || 0, 
            origin: opts.origin || { x: x, y: y },
            id: uid()
        };
    }

    function setupDefaultLevel() { 
        State.particles = [];
        State.constraints = [];
        State.platforms = [];
        State.goal = null;
        State.running = false;
        State.win = false;
        
        State.platforms.push(createPlatform(50, 600, 200, 10));
        State.platforms.push(createPlatform(950, 450, 100, 10));
        State.goal = { x: 1000, y: 450 - CFG.GOAL_R, r: CFG.GOAL_R, id: uid() };

        State.particles.push(makeParticle(150, 600 - CFG.NODE_R));
        State.particles.push(makeParticle(100, 600 - CFG.NODE_R));
    }

    function updatePlatforms(dt) { 
        for (const pl of State.platforms) {
            if (pl.type === 'vertical') {
                pl.angle += pl.speed * dt;
                const dy = Math.sin(pl.angle) * pl.range - (pl.y - pl.origin.y);
                pl.y += dy;
            } else if (pl.type === 'horizontal') {
                pl.angle += pl.speed * dt;
                const dx = Math.sin(pl.angle) * pl.range - (pl.x - pl.origin.x);
                pl.x += dx;
            }
        }
    }

    function checkWin() { 
        if (!State.goal) return;
        let winCount = 0;
        for (const p of State.particles) {
            if (dist(p.x, p.y, State.goal.x, State.goal.y) < State.goal.r) {
                winCount++;
            }
        }
        if (winCount > 0 && !State.win) {
            State.win = true;
            State.running = false;
            showMessage('GESCHAFFT! 🎉', 'Die Partikel haben das Ziel erreicht!');
        }
    }
    
    // --- Speichern/Laden/Undo/Redo Logik (Unverändert) ---
    function snapshot() { 
        return JSON.stringify({ 
            p: State.particles.map(p => ({ x: p.x, y: p.y, r: p.r, pinned: p.pinned, color: p.color, id: p.id })), 
            c: State.constraints.map(c => ({ a: c.a.id, b: c.b.id, rest: c.rest, type: c.type })), 
            pl: State.platforms.map(p => ({ x: p.x, y: p.y, w: p.w, h: p.h, type: p.type, range: p.range, speed: p.speed, angle: p.angle, origin: p.origin, id: p.id })),
            g: State.goal ? { x: State.goal.x, y: State.goal.y, r: State.goal.r, id: State.goal.id } : null,
            bm: State.buildMode
        }); 
    }
    
    function restore(s) { 
        try { 
            const data = JSON.parse(s); 
            const idMap = new Map();
            const ps = data.p.map(o => { 
                const p = makeParticle(o.x, o.y, o.r); 
                p.pinned = !!o.pinned; 
                p.color = o.color || '#00ffd6'; 
                idMap.set(o.id, p); 
                return p; 
            }); 
            const cs = data.c.map(o => {
                 const a = idMap.get(o.a);
                 const b = idMap.get(o.b);
                 if (!a || !b) return null; 
                 const c = { 
                     a, b, rest: o.rest, stiff: 1, 
                     broken: false, 
                     type: o.type || 'rigid',
                     tension: 0
                 }; 
                 const max_length = 300; 
                 const normalized_r = clamp(c.rest, 0, max_length) / max_length;
                 const strength_mult = 1.0 + (1 - normalized_r) * 1.5; 
                 c.break_threshold = CFG.BREAK_THRESHOLD_BASE * strength_mult;
                 return c;
            }).filter(c => c !== null); 
            
            State.particles = ps; 
            State.constraints = cs; 
            
            State.platforms = data.pl ? data.pl.map(p => createPlatform(p.x, p.y, p.w, p.h, { type: p.type, range: p.range, speed: p.speed, angle: p.angle, origin: p.origin })) : [];
            State.goal = data.g ? { x: data.g.x, y: data.g.y, r: data.g.r, id: uid() } : null;
            State.buildMode = data.bm || 'goal';

            resizeCanvas();
            updateUICounts(); 
            applySliderConfig(); // Slider-Konfiguration nach Laden anwenden
        } catch (e) { 
            console.warn('Wiederherstellen fehlgeschlagen', e); 
        } 
    }

    function exportLevel() { 
        const data = snapshot();
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bridge_level.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showMessage('Export', 'Level als bridge_level.json gespeichert.');
    }

    function importLevel() { 
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        pushUndo();
                        restore(event.target.result);
                        showMessage('Import', 'Level erfolgreich geladen.');
                    } catch (err) {
                        showMessage('Import Fehler', 'Ungültiges Level-Format.');
                    }
                };
                reader.readAsText(file);
            }
        };
        input.click();
    }
    
    function pushUndo() { 
        State.redo = []; 
        State.undo.push(snapshot());
        if (State.undo.length > CFG.UNDO_LIMIT) State.undo.shift();
    }
    function undo() { 
        if (State.undo.length === 0) return;
        State.redo.push(snapshot());
        restore(State.undo.pop());
    }
    function redo() { 
        if (State.redo.length === 0) return;
        State.undo.push(snapshot());
        restore(State.redo.pop());
    }
    function saveLocal() { 
        localStorage.setItem(CFG.SAVE_KEY, snapshot()); 
        showMessage('Speichern', 'Bau lokal gespeichert.');
    }
    function loadLocal() { 
        const saved = localStorage.getItem(CFG.SAVE_KEY); 
        if (saved) { 
            pushUndo();
            restore(saved); 
            showMessage('Laden', 'Letzten Bau geladen.');
        } else {
            showMessage('Laden Fehler', 'Kein lokaler Bau gefunden.');
        }
    }

    // --- Eingabe-Handler ---
    function findNodeAt(x, y) { 
        for (let i = State.particles.length - 1; i >= 0; i--) {
            const p = State.particles[i];
            if (dist(x, y, p.x, p.y) < CFG.NODE_HIT_R) return p;
        }
        return null;
    }
    function findConstraintAt(x, y, threshold = 8) { 
        for (const c of State.constraints) {
            const { a, b } = c;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d2 = dx * dx + dy * dy;
            const t = ((x - a.x) * dx + (y - a.y) * dy) / d2;
            
            let closestX, closestY;
            if (t < 0) {
                closestX = a.x; closestY = a.y;
            } else if (t > 1) {
                closestX = b.x; closestY = b.y;
            } else {
                closestX = a.x + t * dx;
                closestY = a.y + t * dy;
            }
            
            if (dist(x, y, closestX, closestY) < threshold) return c;
        }
        return null;
    }
    function findPlatformAt(x, y) { 
        for (let i = State.platforms.length - 1; i >= 0; i--) {
            const pl = State.platforms[i];
            const halfW = pl.w / 2;
            const halfH = pl.h / 2;
            const cx = pl.x + halfW;
            const cy = pl.y + halfH;
            
            if (Math.abs(x - cx) < halfW && Math.abs(y - cy) < halfH) return pl;
        }
        return null;
    }
    function findGoalAt(x, y) { 
        if (State.goal && dist(x, y, State.goal.x, State.goal.y) < State.goal.r) return State.goal;
        return null;
    }

    // --- Rechtsklick Menü Logik ---
    function hideContextMenu() {
        $id('context-menu').style.display = 'none';
        $id('ctx-delete-element').onclick = null;
    }

    function showContextMenu(xScreen, yScreen, deleteFn) {
        const menu = $id('context-menu');
        menu.style.left = xScreen + 'px';
        menu.style.top = yScreen + 'px';
        menu.style.display = 'block';
        $id('ctx-delete-element').onclick = (e) => {
            e.preventDefault();
            pushUndo();
            deleteFn();
            hideContextMenu();
            updateUICounts();
        };
    }

    // Funktion zum Löschen von Elementen an der aktuellen Mausposition
    function tryDeleteAtMouse(pos, e) {
        if (State.mode === 'build' || State.mode === 'edit') {
            const hit = findNodeAt(pos.x, pos.y);
            const constraintHit = findConstraintAt(pos.x, pos.y);

            if (hit) {
                const deleteNode = () => {
                    State.particles = State.particles.filter(p => p !== hit);
                    State.constraints = State.constraints.filter(c => c.a !== hit && c.b !== hit);
                    if (State.selected === hit) State.selected = null;
                    spawnFX(hit.x, hit.y, '#ffffff', 5);
                };
                showContextMenu(e.clientX, e.clientY, deleteNode);
            } else if (constraintHit) {
                const deleteConstraint = () => {
                    State.constraints = State.constraints.filter(c => c !== constraintHit);
                    spawnFX((constraintHit.a.x + constraintHit.b.x) / 2, (constraintHit.a.y + constraintHit.b.y) / 2, '#ffffff', 5);
                };
                showContextMenu(e.clientX, e.clientY, deleteConstraint);
            }
        } else if (State.mode === 'editor') {
            if (State.editMode === 'delete') {
                const hitPlat = findPlatformAt(pos.x, pos.y);
                const hitGoal = findGoalAt(pos.x, pos.y);
    
                if (hitPlat) {
                    const deletePlatform = () => {
                        State.platforms = State.platforms.filter(pl => pl !== hitPlat);
                    };
                    showContextMenu(e.clientX, e.clientY, deletePlatform);
                } else if (hitGoal) {
                    const deleteGoal = () => {
                        State.goal = null;
                    };
                    showContextMenu(e.clientX, e.clientY, deleteGoal);
                }
            }
        }
    }
    
    function onPointerDown(e) {
        e.preventDefault();
        
        State.mouse.isDown = true;
        const pos = screenPosToWorld(e);
        State.mouse.x = pos.x; State.mouse.y = pos.y;
        State.mouse.xStart = pos.x; State.mouse.yStart = pos.y;
        State.mouse.xPrev = pos.x; State.mouse.yPrev = pos.y;
        
        hideContextMenu(); // Kontextmenü immer ausblenden bei Mausklick

        const hit = findNodeAt(pos.x, pos.y);

        if (State.mode === 'build') {
            if (hit) {
                if (State.selected) {
                    if (hit !== State.selected) {
                        pushUndo();
                        addConstraint(State.selected, hit);
                        State.selected = null; 
                    } else {
                        State.selected = null; 
                    }
                } else {
                    State.selected = hit;
                }
            } else {
                pushUndo();
                const newP = addParticle(pos.x, pos.y);
                if (State.selected) {
                    addConstraint(State.selected, newP);
                    State.selected = null;
                } else {
                    State.selected = newP; 
                }
            }
            updateUICounts(); 
        } 
        else if (State.mode === 'edit' && hit) {
             pushUndo(); hit.pinned = !hit.pinned; 
             spawnFX(hit.x, hit.y, hit.pinned ? '#88ff88' : '#ff8888', 8); 
             if (!hit.pinned) State.dragged = hit; // Startet Ziehen nach Entpinnen
             else State.dragged = null; // Stoppt Ziehen bei Pinnen
        } 
        else if (State.mode === 'paint' && hit) {
             pushUndo(); hit.color = '#ff00ff'; 
        }
        else if (State.mode === 'explosion') {
             pushUndo(); 
             for(const p of State.particles) {
                 const d = dist(p.x, p.y, pos.x, pos.y);
                 if (d < 200) {
                     const f = Math.max(0, 200 - d) / 200 * 100;
                     const angle = Math.atan2(p.y - pos.y, p.x - pos.x);
                     p.x += Math.cos(angle) * f;
                     p.y += Math.sin(angle) * f;
                     p.px = p.x;
                     p.py = p.y;
                 }
             }
             spawnFX(pos.x, pos.y, '#ff0000', 30);
        }
        else if (State.mode === 'editor') {
             const hitPlat = findPlatformAt(pos.x, pos.y);
             const hitGoal = findGoalAt(pos.x, pos.y);
             
             if (hitPlat) {
                 State.draggedPlatform = hitPlat;
             } else if (hitGoal) {
                 State.draggedPlatform = hitGoal; 
             } else if (State.editMode === 'platform') {
                pushUndo();
                State.draggedPlatform = createPlatform(pos.x, pos.y, 10, 10);
                State.platforms.push(State.draggedPlatform);
             } else if (State.editMode === 'goal' && !State.goal) {
                pushUndo();
                State.goal = { x: pos.x, y: pos.y, r: CFG.GOAL_R, id: uid() };
                State.draggedPlatform = State.goal;
             }
        }
    }
    
    function onPointerMove(e) {
        const pos = screenPosToWorld(e);
        const dxWorld = pos.x - State.mouse.xPrev;
        const dyWorld = pos.y - State.mouse.yPrev;

        if (State.mouse.isDown && State.dragged) {
            State.dragged.x = pos.x;
            State.dragged.y = pos.y;
            State.dragged.px = pos.x; 
            State.dragged.py = pos.y; 
        } 
        else if (State.mouse.isDown && State.draggedPlatform) {
            const pl = State.draggedPlatform;

            if (State.mode === 'editor') {
                 if (State.editMode === 'move' || pl === State.goal) {
                     pl.x += dxWorld; pl.y += dyWorld;
                     if (pl.origin) { pl.origin.x += dxWorld; pl.origin.y += dyWorld; } 
                 } else if (State.editMode === 'platform' && pl !== State.goal) {
                     pl.w = Math.max(10, pos.x - State.mouse.xStart);
                     pl.h = Math.max(10, pos.y - State.mouse.yStart);
                 }
            }
        }
        
        State.mouse.x = pos.x; 
        State.mouse.y = pos.y;
        State.mouse.xPrev = pos.x;
        State.mouse.yPrev = pos.y;
    }
    
    function onPointerUp(e) { 
        State.mouse.isDown = false;
        
        if (State.mode === 'editor' && State.draggedPlatform && State.draggedPlatform !== State.goal && State.editMode === 'platform') {
            const pl = State.draggedPlatform;
            if (pl.w < 0) { pl.x += pl.w; pl.w = -pl.w; }
            if (pl.h < 0) { pl.y += pl.h; pl.h = -pl.h; }
        }

        State.dragged = null;
        State.draggedPlatform = null;
    }
    
    function onRightDown(e) { 
        e.preventDefault();
        const pos = screenPosToWorld(e);
        tryDeleteAtMouse(pos, e); 
    }

    // --- FX (Visual Effects) ---
    function spawnFX(x, y, color, count) {
        for (let i = 0; i < count; i++) {
            State.fx.push({
                x, y, color, 
                vx: (Math.random() - 0.5) * 500, 
                vy: (Math.random() - 0.5) * 500,
                life: 1.0, 
                maxLife: 1.0
            });
        }
    }
    function updateFX(dt) {
        State.fx = State.fx.filter(f => f.life > 0);
        for (const f of State.fx) {
            f.x += f.vx * dt;
            f.y += f.vy * dt;
            f.vx *= 0.98;
            f.vy *= 0.98;
            f.life -= dt;
        }
    }
    function drawFX() {
        for (const f of State.fx) {
            ctx.fillStyle = f.color;
            ctx.globalAlpha = f.life / f.maxLife;
            ctx.beginPath();
            ctx.arc(f.x, f.y, 2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1.0;
    }

    // --- Event Listener ---
    canvas.addEventListener('mousedown', function (e) { 
        if (e.button === 2) onRightDown(e); 
        else onPointerDown(e); 
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('touchstart', onPointerDown, { passive: false });
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('touchmove', onPointerMove, { passive: false });
    window.addEventListener('mouseup', onPointerUp);
    window.addEventListener('touchend', onPointerUp);

    // --- Rendering ---
    function drawBackground() {
        const w = State.worldW, h = State.worldH;
        ctx.save();
        const DPR = Math.min(window.devicePixelRatio || 1, 2);
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0); 
        
        const g = ctx.createLinearGradient(0, 0, 0, h);
        
        if (State.theme === 'neon') { g.addColorStop(0, '#071026'); g.addColorStop(1, '#050a1a'); }
        else if (State.theme === 'night') { g.addColorStop(0, '#000022'); g.addColorStop(1, '#000011'); }
        else if (State.theme === 'ice') { g.addColorStop(0, '#ddffff'); g.addColorStop(1, '#aaffff'); }
        else if (State.theme === 'forest') { g.addColorStop(0, '#153015'); g.addColorStop(1, '#0f200f'); }
        else if (State.theme === 'classic') { g.addColorStop(0, '#444444'); g.addColorStop(1, '#333333'); }
        
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width / DPR, canvas.height / DPR); 
        ctx.restore();
        
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0); 

        ctx.fillStyle = State.theme === 'ice' ? '#999' : '#0a0a0a';
        ctx.fillRect(0, floorY, State.worldW, 10); 
    }
    
    function drawConstraints() { 
        for (const c of State.constraints) {
            if (c.broken) {
                ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
                ctx.lineWidth = 1;
                ctx.setLineDash([2, 5]);
            } else {
                ctx.setLineDash([]);
                
                let color = '#00ffd6'; 
                if (c.type === 'cable') color = '#ffbb00';
                else if (c.type === 'rod') color = '#00bfff';

                if (State.useBagMode) {
                    const maxTension = c.break_threshold;
                    const normalizedTension = clamp(c.tension / maxTension, 0, 1);
                    const r = Math.floor(255 * normalizedTension);
                    const g = Math.floor(255 * (1 - normalizedTension));
                    color = `rgb(${r}, ${g}, 0)`;
                }

                ctx.strokeStyle = color;
                ctx.lineWidth = CFG.LINE_W;
            }

            ctx.beginPath();
            ctx.moveTo(c.a.x, c.a.y);
            ctx.lineTo(c.b.x, c.b.y);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    }
    
    function drawPlatforms() { 
        ctx.fillStyle = CFG.PLATFORM_COLOR;
        for (const pl of State.platforms) {
            ctx.fillRect(pl.x, pl.y, pl.w, pl.h);
        }
        if (State.mode === 'editor' && State.draggedPlatform && State.draggedPlatform !== State.goal) {
            ctx.strokeStyle = '#ffc107';
            ctx.lineWidth = 2;
            ctx.strokeRect(State.draggedPlatform.x, State.draggedPlatform.y, State.draggedPlatform.w, State.draggedPlatform.h);
        }
    }
    
    function drawParticles() { 
        for (const p of State.particles) {
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();

            if (p.pinned) {
                ctx.strokeStyle = '#ffc107';
                ctx.lineWidth = 2;
                ctx.strokeRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
            }
        }
        if (State.mode === 'build' && State.selected) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.lineWidth = CFG.LINE_W;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(State.selected.x, State.selected.y);
            ctx.lineTo(State.mouse.x, State.mouse.y);
            ctx.stroke();
            ctx.setLineDash([]);
            
            ctx.strokeStyle = '#ffc107';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(State.selected.x, State.selected.y, State.selected.r + 3, 0, Math.PI * 2);
            ctx.stroke();
        }
    }
    
    function drawGoal() { 
        if (!State.goal) return;
        
        ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
        ctx.strokeStyle = State.win ? '#00ff00' : '#00aaff';
        ctx.lineWidth = 3;
        
        ctx.beginPath();
        ctx.arc(State.goal.x, State.goal.y, State.goal.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = State.win ? '#00ff00' : '#fff';
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('ZIEL', State.goal.x, State.goal.y + 7);
        
        if (State.mode === 'editor' && State.draggedPlatform === State.goal) {
            ctx.strokeStyle = '#ffc107';
            ctx.lineWidth = 4;
            ctx.stroke();
        }
    }

    function drawDebugOverlay() {
        if (State.debug.showBoundingBoxes) {
            ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
            ctx.lineWidth = 1;
            for (const pl of State.platforms) {
                ctx.strokeRect(pl.x, pl.y, pl.w, pl.h);
            }
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
            for (const p of State.particles) {
                ctx.beginPath();
                ctx.arc(p.x, p.y, CFG.NODE_HIT_R, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        if (State.debug.showForceVectors && State.running) {
            ctx.lineWidth = 2;
            for (const p of State.particles) {
                if (p.pinned) continue;
                const scale = 50; 
                ctx.strokeStyle = '#ff8800'; 
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p.x + p.forceX * scale, p.y + p.forceY * scale);
                ctx.stroke();
            }
        }
    }

    function drawHUD() {
        if (State.debug.showFPS) {
            const dpr = window.devicePixelRatio || 1;
            const fps = State.debug.fpsHistory.reduce((a, b) => a + b) / State.debug.fpsHistory.length;
            
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0); 
            
            ctx.fillStyle = '#fff';
            ctx.font = '16px Arial';
            ctx.textAlign = 'right';
            
            ctx.fillText(`FPS: ${fps.toFixed(1)}`, canvas.width / dpr - 10, 35);
        }
    }

    // --- Haupt-Loop ---
    let last = now();
    function mainLoop() {
        const t = now();
        const dt = Math.min((t - last) / 1000, 1 / 30); 
        
        State.debug.lastFrameTime = t - last;
        const currentFPS = 1000 / State.debug.lastFrameTime;
        State.debug.fpsHistory.shift();
        State.debug.fpsHistory.push(currentFPS);
        
        last = t;
        
        const subs = State.useChaosMode ? CFG.CHAOS_SUBSTEPS : CFG.SUBSTEPS;
        
        if (State.running && !State.win) {
            const sdt = dt / subs;
            for (let i = 0; i < subs; i++) { 
                updatePlatforms(sdt); 
                integrateVerlet(sdt); 
                satisfyConstraints(); 
                if (State.mode === 'wind' || State.useChaosMode) applyWind(sdt); 
            }
            checkWin();
        } else if (!State.running) {
             updatePlatforms(0.0001); 
        }
        
        updateFX(dt);
        
        const DPR = Math.min(window.devicePixelRatio || 1, 2);
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0); 
        
        drawBackground(); 
        drawGoal(); 
        drawPlatforms(); 
        drawConstraints(); 
        drawParticles(); 
        drawFX();
        drawDebugOverlay(); 
        
        drawHUD(); 
        
        requestAnimationFrame(mainLoop);
    }

    // --- UI-Funktionen ---
    function setMode(m) { 
        State.mode = m;
        State.dragged = null;
        State.draggedPlatform = null;
        
        if (m !== 'build') State.selected = null; 
        
        if (m === 'editor') {
            modeText.textContent = `Modus: Editor (${State.editMode})`;
            toggleEditorControls(true);
        } else if (m === 'build') {
             modeText.textContent = `Modus: Bauen`;
             toggleEditorControls(false);
             State.running = false; 
        } else if (m === 'edit') {
             modeText.textContent = `Modus: Pin (Rechtsklick: Löschen)`;
             toggleEditorControls(false);
        } else if (m === 'wind') {
             modeText.textContent = `Modus: Wind (läuft)`;
             State.running = true;
             toggleEditorControls(false);
        } else if (m === 'explosion') {
             modeText.textContent = `Modus: Explosion (Klick, Rechtsklick: Löschen)`;
             toggleEditorControls(false);
        } else if (m === 'paint') {
             modeText.textContent = `Modus: Farbe ändern`;
             toggleEditorControls(false);
        } else if (m === 'bag') {
             State.useBagMode = !State.useBagMode;
             modeText.textContent = `Modus: Tragkraft-Anzeige ${State.useBagMode ? 'AN' : 'AUS'}`;
             toggleEditorControls(false);
             setMode('build');
        } else if (m === 'chaos') {
             State.useChaosMode = !State.useChaosMode;
             modeText.textContent = `Modus: Chaos💥 ${State.useChaosMode ? 'AN' : 'AUS'}`;
             toggleEditorControls(false);
             setMode('build');
        } else {
             modeText.textContent = `Modus: ${m}`;
             toggleEditorControls(false);
        }
    }
    
    function setConstraintType(t) { 
        State.constraintType = t;
        showMessage('Constraint', `Neuer Typ: ${t}`);
    }
    
    function setEditMode(m) { 
        State.editMode = m;
        modeText.textContent = `Modus: Editor (${m})`;
        State.draggedPlatform = null;
    }
    
    function toggleEditorControls(visible) { 
        const editorControls = $id('editor-controls');
        editorControls.style.display = visible ? 'flex' : 'none';
    }
    
    function updateUICounts() { 
        $id('node-count').textContent = `Knoten: ${State.particles.length}`;
    }
    function updatePlayButtonText() { 
        btnPlay.textContent = State.running ? 'Pause' : 'Start';
    }
    function showMessage(title, text) { 
        const msgBox = $id('msg-box');
        $id('msg-title').textContent = title;
        $id('msg-text').textContent = text;
        msgBox.classList.remove('hidden');
    }
    function hideMessage() { 
        $id('msg-box').classList.add('hidden');
    }
    
    function calculateKineticEnergy() {
        let energy = 0;
        for (const p of State.particles) {
            if (p.pinned) continue;
            const vx = p.x - p.px;
            const vy = p.y - p.py;
            energy += 0.5 * 1 * (vx * vx + vy * vy) * 100; 
        }
        return energy;
    }

    function calculatePotentialEnergy() {
        let energy = 0;
        const g = CFG.GRAVITY / 1000; 

        for (const p of State.particles) {
            if (p.pinned) continue;
            energy += 1 * g * (State.worldH - p.y); 
        }

        for (const c of State.constraints) {
            if (c.broken) continue;
            const d = dist(c.a.x, c.a.y, c.b.x, c.b.y);
            const stretch = d - c.rest;
            energy += 0.5 * c.stiff * stretch * stretch * 0.1; 
        }
        return energy;
    }

    function wireUI() {
        const bind = (id, ev, fn) => { const el = $id(id); if (el) el.addEventListener(ev, fn); };
        
        bind('btn-play', 'click', () => { State.running = !State.running; updatePlayButtonText(); });
        bind('btn-build', 'click', () => setMode('build'));
        bind('btn-editor', 'click', () => setMode('editor'));
        bind('btn-edit', 'click', () => setMode('edit'));
        bind('btn-wind', 'click', () => setMode('wind'));
        bind('btn-explosion', 'click', () => setMode('explosion'));
        bind('btn-paint', 'click', () => setMode('paint'));
        bind('btn-bag', 'click', () => setMode('bag'));
        bind('btn-chaos', 'click', () => setMode('chaos'));

        bind('btn-clear', 'click', () => { pushUndo(); State.particles = []; State.constraints = []; updateUICounts(); });
        bind('btn-undo', 'click', undo);
        bind('btn-redo', 'click', redo);
        bind('btn-save', 'click', saveLocal);
        bind('btn-load', 'click', loadLocal);
        bind('btn-export', 'click', exportLevel);
        bind('btn-import', 'click', importLevel);
        bind('btn-sandbox', 'click', () => { pushUndo(); State.buildMode = 'sandbox'; setupDefaultLevel(); showMessage('Modus', 'Sandbox-Modus aktiviert.'); });
        bind('btn-goal', 'click', () => { pushUndo(); State.buildMode = 'goal'; setupDefaultLevel(); showMessage('Modus', 'Ziel-Level geladen.'); });
        bind('msg-ok', 'click', hideMessage);

        bind('btn-type-rigid', 'click', () => setConstraintType('rigid'));
        bind('btn-type-cable', 'click', () => setConstraintType('cable'));
        bind('btn-type-rod', 'click', () => setConstraintType('rod'));

        bind('btn-editor-move', 'click', () => setEditMode('move'));
        bind('btn-editor-platform', 'click', () => setEditMode('platform'));
        bind('btn-editor-goal', 'click', () => setEditMode('goal'));
        bind('btn-editor-delete', 'click', () => setEditMode('delete'));

        bind('theme-select', 'change', (e) => { State.theme = e.target.value; drawBackground(); });

        bind('btn-debug-fps', 'click', () => { State.debug.showFPS = !State.debug.showFPS; showMessage('Debug', `FPS-Anzeige: ${State.debug.showFPS ? 'AN' : 'AUS'}`); });
        bind('btn-debug-bounds', 'click', () => { State.debug.showBoundingBoxes = !State.debug.showBoundingBoxes; showMessage('Debug', `Bounding Boxes: ${State.debug.showBoundingBoxes ? 'AN' : 'AUS'}`); });
        bind('btn-debug-forces', 'click', () => { State.debug.showForceVectors = !State.debug.showForceVectors; showMessage('Debug', `Kraftvektoren: ${State.debug.showForceVectors ? 'AN' : 'AUS'}`); });
        bind('btn-debug-energy', 'click', () => { 
            const eKin = calculateKineticEnergy().toFixed(2);
            const ePot = calculatePotentialEnergy().toFixed(2);
            showMessage('Energie-Analyse', `Kin. Energie: ${eKin} J\nPot. Energie: ${ePot} J`); 
        });

        setupSliderListeners(); // NEU: Slider-Steuerung

        // Klick außerhalb des Kontextmenüs schließt es
        document.addEventListener('click', (e) => {
            const menu = $id('context-menu');
            if (menu.style.display === 'block' && !menu.contains(e.target)) {
                hideContextMenu();
            }
        });
    }

    // --- Bootstrapping ---
    function init() {
        wireUI();
        resizeCanvas();
        setupDefaultLevel();
        updatePlayButtonText();
        $id('theme-select').value = State.theme;
        pushUndo();
    }
    
    init();
    last = now();
    requestAnimationFrame(mainLoop);
})();