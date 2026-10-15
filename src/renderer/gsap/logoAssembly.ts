/** Five part-by-part assemblies, using the exact application mark geometry. */
import type { BackgroundEffectPreset } from '@shared/types/plugin';
interface Part {
    group: SVGGElement;
    cx: number;
    cy: number;
}
export function createLogoAssembly(mark: SVGSVGElement, style: BackgroundEffectPreset) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const hex = mark.querySelector<SVGPathElement>('.splash-hex')!;
    const originalElements = [mark, hex, ...mark.querySelectorAll<SVGElement>('.splash-tile-l,.splash-tile-r,.splash-node')];
    const snapshots = originalElements.map(element => ({ element, style: element.getAttribute('style'), transform: element.getAttribute('transform') }));
    const variant = ['fold', 'aurora', 'orbit', 'ripple', 'tunnel'].indexOf(style);
    const originalHexTransform = hex.getAttribute('transform');
    const points = (hex.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const make = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>) => { const element = document.createElementNS(svgNS, name); Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value))); return element; };
    const wrap = (element: SVGElement, cx: number, cy: number) => { const group = make('g', { 'data-assembly-part': element.getAttribute('class') || 'part' }); element.parentNode!.insertBefore(group, element); group.appendChild(element); return { group, cx, cy }; };
    const left = wrap(mark.querySelector<SVGElement>('.splash-tile-l')!, 74, 92);
    const right = wrap(mark.querySelector<SVGElement>('.splash-tile-r')!, 125, 108);
    const node = wrap(mark.querySelector<SVGElement>('.splash-node')!, 100, 100);
    const segmentGroup = make('g', { 'data-assembly-edges': '', 'fill': 'none', 'stroke': 'currentColor', 'stroke-width': '6', 'stroke-linecap': 'round' });
    mark.insertBefore(segmentGroup, hex);
    const edges: (Part & {
        line: SVGPathElement;
    })[] = [];
    for (let i = 0; i < 6; i++) {
        const next = (i + 1) % 6, x1 = points[i * 2], y1 = points[i * 2 + 1], x2 = points[next * 2], y2 = points[next * 2 + 1];
        const line = make('path', { d: `M${x1} ${y1} L${x2} ${y2}`, pathLength: 1 });
        segmentGroup.appendChild(line);
        edges.push({ ...wrap(line, (x1 + x2) / 2, (y1 + y2) / 2), line });
    }
    const fx = make('g', { 'data-assembly-fx': '', fill: 'none', 'stroke': '#d9fff2', 'stroke-width': '1.4', 'pointer-events': 'none' });
    mark.insertBefore(fx, mark.firstChild);
    const rings = [make('circle', { cx: 100, cy: 100, r: 0 }), make('circle', { cx: 100, cy: 100, r: 0 })];
    rings.forEach(r => fx.appendChild(r));
    const orbit = make('ellipse', { cx: 100, cy: 100, rx: 94, ry: 48, transform: 'rotate(-25 100 100)', 'stroke-dasharray': '3 8' });
    fx.appendChild(orbit);
    const ghosts = [hex.cloneNode(true) as SVGPathElement, hex.cloneNode(true) as SVGPathElement];
    ghosts.forEach(g => { g.removeAttribute('class'); g.setAttribute('stroke-width', '1.5'); fx.appendChild(g); });
    const follower = make('circle', { cx: 100, cy: 28, r: 4, fill: '#e8fff5', stroke: 'none' });
    mark.appendChild(follower);
    const length = hex.getTotalLength();
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    const p = (t: number, start: number, duration: number) => clamp((t - start) / duration);
    const out = (x: number) => 1 - Math.pow(1 - x, 3);
    const back = (x: number) => 1 + 2.15 * Math.pow(x - 1, 3) + 1.15 * Math.pow(x - 1, 2);
    const setPart = (part: Part, dx = 0, dy = 0, rotation = 0, sx = 1, sy = sx, alpha = 1) => {
        part.group.setAttribute('transform', `translate(${part.cx + dx} ${part.cy + dy}) rotate(${rotation}) scale(${sx} ${sy}) translate(${-part.cx} ${-part.cy})`);
        part.group.style.opacity = String(clamp(alpha));
    };
    const setHex = (progress: number, rotation = 0) => { hex.style.opacity = '1'; hex.style.strokeDasharray = '1'; hex.style.strokeDashoffset = String(1 - clamp(progress)); hex.setAttribute('transform', `rotate(${rotation} 100 100)`); };
    const flash = (ring: SVGCircleElement, t: number, start: number, duration: number, from: number, to: number) => { const v = p(t, start, duration); ring.setAttribute('r', String(from + (to - from) * out(v))); ring.style.opacity = String(v > 0 && v < 1 ? Math.sin(Math.PI * v) * .65 : 0); };
    function render(t: number, staticOnly = false) {
        const done = staticOnly || t >= 2.30;
        mark.style.opacity = '1';
        mark.style.transform = 'none';
        [left, right, node, ...edges].forEach(part => setPart(part));
        [orbit, follower, ...rings, ...ghosts].forEach(el => el.style.opacity = '0');
        hex.style.opacity = '0';
        hex.style.strokeDasharray = 'none';
        hex.style.strokeDashoffset = '0';
        if (originalHexTransform)
            hex.setAttribute('transform', originalHexTransform);
        else
            hex.removeAttribute('transform');
        segmentGroup.style.opacity = '0';
        if (done) {
            hex.style.opacity = '1';
            return;
        }
        if (variant === 0) {
            segmentGroup.style.opacity = '1';
            edges.forEach((part, i) => { const v = p(t, .14 + i * .075, .78), e = out(v), dx = part.cx - 100, dy = part.cy - 100, r = Math.hypot(dx, dy); setPart(part, dx / r * 66 * (1 - e), dy / r * 66 * (1 - e), (i % 2 ? 32 : -32) * (1 - e), 1, 1, v * 4); });
            const a = p(t, .48, .83), b = p(t, .64, .83);
            setPart(left, -72 * (1 - back(a)), 12 * (1 - out(a)), -20 * (1 - out(a)), 1, 1, a * 4);
            setPart(right, 72 * (1 - back(b)), -12 * (1 - out(b)), 20 * (1 - out(b)), 1, 1, b * 4);
            const v = p(t, 1.32, .38);
            setPart(node, 0, -24 * (1 - out(v)), 0, .35 + .65 * back(v), .35 + .65 * back(v), v * 4);
            flash(rings[0], t, 1.58, .48, 10, 36);
        }
        else if (variant === 1) {
            const trace = p(t, .10, 1.30);
            setHex(trace);
            const point = hex.getPointAtLength(length * trace);
            follower.setAttribute('cx', String(point.x));
            follower.setAttribute('cy', String(point.y));
            follower.style.opacity = String(trace > 0 && trace < 1 ? Math.min(1, trace * 8, (1 - trace) * 10) : 0);
            const a = p(t, .35, 1.05), b = p(t, .59, 1.05), ea = out(a), eb = out(b);
            setPart(left, -62 * (1 - ea), -30 * Math.sin(Math.PI * a) + 14 * (1 - ea), -24 * (1 - ea), .72 + .28 * ea, .72 + .28 * ea, a * 4);
            setPart(right, 62 * (1 - eb), 30 * Math.sin(Math.PI * b) - 14 * (1 - eb), 24 * (1 - eb), .72 + .28 * eb, .72 + .28 * eb, b * 4);
            const v = p(t, 1.49, .34);
            setPart(node, 0, 20 * (1 - out(v)), 0, .3 + .7 * back(v), .3 + .7 * back(v), v * 4);
            flash(rings[0], t, 1.72, .43, 9, 28);
        }
        else if (variant === 2) {
            const trace = out(p(t, .26, 1.24));
            setHex(trace, -60 * (1 - trace));
            const a = p(t, .20, 1.30), b = p(t, .38, 1.30), ra = 94 * (1 - out(a)), rb = 94 * (1 - out(b)), aa = Math.PI + a * Math.PI * 1.65, ab = -b * Math.PI * 1.65;
            setPart(left, Math.cos(aa) * ra, Math.sin(aa) * ra * .7, -170 * (1 - out(a)), .65 + .35 * out(a), .65 + .35 * out(a), a * 5);
            setPart(right, Math.cos(ab) * rb, Math.sin(ab) * rb * .7, 170 * (1 - out(b)), .65 + .35 * out(b), .65 + .35 * out(b), b * 5);
            orbit.style.opacity = String(Math.sin(Math.PI * p(t, .16, 1.55)) * .35);
            const v = p(t, 1.55, .40);
            setPart(node, 0, -36 * (1 - out(v)), 0, .45 + .55 * back(v), .45 + .55 * back(v), v * 4);
            flash(rings[0], t, 1.78, .43, 10, 30);
        }
        else if (variant === 3) {
            const n = p(t, .10, .38);
            setPart(node, 0, 0, 0, .15 + .85 * back(n), .15 + .85 * back(n), n * 3);
            const a = p(t, .45, .83), b = p(t, .60, .83), ea = back(a), eb = back(b);
            setPart(left, -38 * (1 - ea), -12 * (1 - ea), -9 * (1 - out(a)), .45 + .55 * out(a) + Math.sin(Math.PI * a) * .22, .52 + .48 * out(a), a * 4);
            setPart(right, 38 * (1 - eb), 12 * (1 - eb), 9 * (1 - out(b)), .45 + .55 * out(b) + Math.sin(Math.PI * b) * .22, .52 + .48 * out(b), b * 4);
            segmentGroup.style.opacity = '1';
            edges.forEach((part, i) => { const v = p(t, .72 + i * .065, .73), e = back(v), dx = part.cx - 100, dy = part.cy - 100; setPart(part, dx * .42 * (1 - e), dy * .42 * (1 - e), (i % 2 ? 8 : -8) * (1 - out(v)), .82 + .18 * out(v), 1, v * 4); });
            flash(rings[0], t, .20, 1.24, 8, 115);
            flash(rings[1], t, .46, 1.42, 8, 110);
        }
        else {
            segmentGroup.style.opacity = '1';
            edges.forEach((part, i) => { const v = p(t, .12 + i * .085, .87), e = out(v), scale = .08 + .92 * e; setPart(part, (100 - part.cx) * (1 - e), (100 - part.cy) * (1 - e), (i % 2 ? 40 : -40) * (1 - e), scale, scale, v * 4); });
            const a = p(t, .73, .74), b = p(t, .91, .74), ea = out(a), eb = out(b);
            setPart(left, (100 - left.cx) * (1 - ea), -38 * (1 - ea), -28 * (1 - ea), .06 + .94 * ea, .06 + .94 * ea, a * 4);
            setPart(right, (100 - right.cx) * (1 - eb), 38 * (1 - eb), 28 * (1 - eb), .06 + .94 * eb, .06 + .94 * eb, b * 4);
            const v = p(t, 1.48, .39);
            setPart(node, 0, 0, 0, .05 + .95 * back(v), .05 + .95 * back(v), v * 4);
            ghosts.forEach((g, i) => { const v = p(t, .13 + i * .25, 1.22), s = .08 + 1.65 * out(v); g.setAttribute('transform', `translate(100 100) scale(${s}) translate(-100 -100)`); g.style.opacity = String(v > 0 && v < 1 ? Math.sin(Math.PI * v) * .35 : 0); });
        }
    }
    function dispose() {
        for (const part of [left, right, node]) {
            part.group.replaceWith(...Array.from(part.group.childNodes));
        }
        segmentGroup.remove();
        fx.remove();
        follower.remove();
        for (const { element, style, transform } of snapshots) {
            if (style === null)
                element.removeAttribute('style');
            else
                element.setAttribute('style', style);
            if (transform === null)
                element.removeAttribute('transform');
            else
                element.setAttribute('transform', transform);
        }
    }
    return { render, dispose };
}
