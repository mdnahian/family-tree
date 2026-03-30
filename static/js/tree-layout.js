/**
 * Custom family tree layout engine.
 *
 * All nodes visible, stable positions, D3 zoom/pan.
 * Two-pass: assign Y by generation, then assign X by family grouping.
 */
(function () {
    'use strict';

    let CARD_W = 170, CARD_H = 188;
    const CARD_GAP_X = 40;
    const SPOUSE_GAP = 30;
    const GEN_GAP = 100;

    /**
     * Order a spouse cluster so the person with most spouses is in the center,
     * with spouses alternating left and right.
     * For a simple couple [A, B], returns [A, B].
     * For polygamy [A, B, C] where A has 2 spouses, returns [B, A, C].
     */
    function orderSpouseCluster(members, spousesOf) {
        if (members.length <= 2) return members;

        // Find hub = person with most spouse connections within this cluster
        const memberSet = new Set(members);
        let hub = members[0];
        let maxSpouses = 0;
        members.forEach(mid => {
            const count = (spousesOf.get(mid) || []).filter(s => memberSet.has(s)).length;
            if (count > maxSpouses) { maxSpouses = count; hub = mid; }
        });

        // Place hub in center, spouses alternating left/right
        const others = members.filter(m => m !== hub);
        const result = [];
        others.forEach((s, i) => {
            if (i % 2 === 0) result.push(s);   // left side (will be before hub)
        });
        result.push(hub);
        others.forEach((s, i) => {
            if (i % 2 === 1) result.push(s);   // right side (after hub)
        });
        return result;
    }

    function computeLayout(persons) {
        const byId = new Map();
        persons.forEach(p => byId.set(p.id, p));

        const parentsOf = new Map();
        const childrenOf = new Map();
        const spousesOf = new Map();

        persons.forEach(p => {
            parentsOf.set(p.id, []);
            childrenOf.set(p.id, []);
            spousesOf.set(p.id, []);
        });
        persons.forEach(p => {
            const r = p.rels || {};
            if (r.father) parentsOf.get(p.id).push(r.father);
            if (r.mother) parentsOf.get(p.id).push(r.mother);
            (r.children || []).forEach(cid => {
                if (!childrenOf.get(p.id).includes(cid)) childrenOf.get(p.id).push(cid);
            });
            (r.spouses || []).forEach(sid => {
                if (!spousesOf.get(p.id).includes(sid)) spousesOf.get(p.id).push(sid);
            });
        });

        // ── Pass 1: assign generation via BFS (down from children, up from parents) ──
        // Strategy: BFS that propagates in ALL directions:
        //   - children → gen + 1
        //   - parents → gen - 1
        //   - spouses → same gen
        // Start from any person, let it spread. Handles in-laws at any depth.
        const gen = new Map();

        // Seed from the first person (arbitrary starting point)
        gen.set(persons[0].id, 0);
        const queue = [persons[0].id];

        while (queue.length) {
            const pid = queue.shift();
            const g = gen.get(pid);

            // Spouses → same generation
            spousesOf.get(pid).forEach(sid => {
                if (!gen.has(sid)) { gen.set(sid, g); queue.push(sid); }
            });

            // Children → generation + 1
            childrenOf.get(pid).forEach(cid => {
                if (!gen.has(cid)) { gen.set(cid, g + 1); queue.push(cid); }
            });

            // Parents → generation - 1
            parentsOf.get(pid).forEach(parentId => {
                if (!gen.has(parentId)) { gen.set(parentId, g - 1); queue.push(parentId); }
            });
        }

        // Handle disconnected components: seed any unvisited person and BFS again
        persons.forEach(p => {
            if (gen.has(p.id)) return;
            gen.set(p.id, 0);
            const q2 = [p.id];
            while (q2.length) {
                const pid = q2.shift();
                const g = gen.get(pid);
                spousesOf.get(pid).forEach(sid => { if (!gen.has(sid)) { gen.set(sid, g); q2.push(sid); } });
                childrenOf.get(pid).forEach(cid => { if (!gen.has(cid)) { gen.set(cid, g + 1); q2.push(cid); } });
                parentsOf.get(pid).forEach(parentId => { if (!gen.has(parentId)) { gen.set(parentId, g - 1); q2.push(parentId); } });
            }
        });

        // Normalize: shift so the minimum generation = 0
        const minGen = Math.min(...gen.values());
        if (minGen !== 0) {
            gen.forEach((g, pid) => gen.set(pid, g - minGen));
        }

        // ── Build couple clusters (spouse groups) ──
        const visited = new Set();
        const coupleOf = new Map(); // personId → coupleIndex
        const couples = [];

        persons.forEach(p => {
            if (visited.has(p.id)) return;
            const cluster = [];
            const q = [p.id];
            while (q.length) {
                const id = q.shift();
                if (visited.has(id)) continue;
                visited.add(id);
                cluster.push(id);
                spousesOf.get(id).forEach(sid => { if (!visited.has(sid)) q.push(sid); });
            }
            const idx = couples.length;
            const children = new Set();
            cluster.forEach(mid => childrenOf.get(mid).forEach(cid => children.add(cid)));
            couples.push({ members: cluster, children: [...children], gen: gen.get(p.id) });
            cluster.forEach(mid => coupleOf.set(mid, idx));
        });

        // ── Pass 2: assign X positions, generation by generation ──
        // For each generation, determine the ordering of persons.
        // Children should appear below and centered under their parent couple.
        // Strategy: process generations top-down. For each couple in gen g,
        // its children in gen g+1 are placed consecutively.

        const positions = new Map();
        const maxGen = Math.max(...[...gen.values()]);

        // For each generation, build an ordered list of "slots" (couple groups)
        // A slot = a couple or a single person at that generation level.
        // Order is determined by: children appear in the order of their parent couple,
        // which appear in the order of THEIR parent couple, etc.

        // Build ordered list per generation
        const genOrder = new Map(); // gen → [personId, ...] in left-to-right order

        // Start with generation 0: order couples left to right
        const gen0Couples = couples.filter(c => c.gen === 0);
        const gen0Order = [];
        gen0Couples.forEach(c => {
            const ordered = orderSpouseCluster(c.members, spousesOf);
            ordered.forEach(m => gen0Order.push(m));
        });
        genOrder.set(0, gen0Order);

        // For subsequent generations, order by parent position
        for (let g = 1; g <= maxGen; g++) {
            const prevOrder = genOrder.get(g - 1) || [];
            const ordered = [];
            const placed = new Set();

            // Go through previous gen's persons in order
            // For each, find their children in this generation
            // Collect children grouped by parent couple, preserving sibling order
            // but keeping each child with their spouse(s) as a unit
            const processedCouples = new Set();
            prevOrder.forEach(pid => {
                // Find which couple this parent belongs to
                const parentCouple = couples.find(c => c.members.includes(pid));
                if (!parentCouple || processedCouples.has(parentCouple)) return;
                processedCouples.add(parentCouple);

                // Collect siblings (children of this couple in this gen)
                const siblings = [];
                parentCouple.children.forEach(cid => {
                    if (gen.get(cid) !== g || placed.has(cid)) return;
                    siblings.push(cid);
                });
                if (siblings.length === 0) return;

                const sibSet = new Set(siblings);
                // For each sibling, find their spouses (not siblings themselves)
                const spouseMap = new Map();
                siblings.forEach(cid => {
                    spouseMap.set(cid, (spousesOf.get(cid) || []).filter(sid =>
                        gen.get(sid) === g && !placed.has(sid) && !sibSet.has(sid)
                    ));
                });

                // Determine spouse placement by checking where each spouse's
                // birth family appears in the parent generation's ordering.
                // Spouses from a family to the RIGHT go on the right edge, etc.
                // Siblings are reordered so the "connecting" sibling is on the
                // matching edge, keeping all siblings adjacent.
                const parentGenOrder = genOrder.get(g - 1) || [];
                // Find the average index of our parent couple in the parent gen order
                const myParentIndices = parentCouple.members.map(m => parentGenOrder.indexOf(m)).filter(i => i >= 0);
                const myParentAvgIdx = myParentIndices.length
                    ? myParentIndices.reduce((a, b) => a + b, 0) / myParentIndices.length
                    : 0;

                // For each sibling, classify their spouse direction
                const sibDirection = new Map(); // cid → 'left' | 'right' | null
                siblings.forEach(cid => {
                    const sp = spouseMap.get(cid) || [];
                    let dir = null;
                    for (const sid of sp) {
                        const spCouple = couples.find(c2 => c2 !== parentCouple && c2.children.includes(sid));
                        if (spCouple) {
                            const spIndices = spCouple.members.map(m => parentGenOrder.indexOf(m)).filter(i => i >= 0);
                            if (spIndices.length) {
                                const spAvgIdx = spIndices.reduce((a, b) => a + b, 0) / spIndices.length;
                                dir = spAvgIdx > myParentAvgIdx ? 'right' : 'left';
                                break;
                            }
                        }
                    }
                    sibDirection.set(cid, dir);
                });

                // Reorder siblings: those connecting LEFT go first, then neutral, then connecting RIGHT
                const sortedSiblings = [...siblings].sort((a, b) => {
                    const da = sibDirection.get(a);
                    const db = sibDirection.get(b);
                    const va = da === 'left' ? 0 : da === null ? 1 : 2;
                    const vb = db === 'left' ? 0 : db === null ? 1 : 2;
                    return va - vb;
                });

                // Place spouses adjacent to their partner.
                // First sibling's spouse goes LEFT, last goes RIGHT,
                // middle siblings' spouses go immediately after them.
                const lastIdx = sortedSiblings.length - 1;
                sortedSiblings.forEach((cid, idx) => {
                    const sp = spouseMap.get(cid) || [];
                    const dir = sibDirection.get(cid);
                    // First sibling: spouse on the left
                    if (idx === 0 && sortedSiblings.length > 1 && sp.length > 0 && (dir === 'left' || dir === null)) {
                        sp.forEach(sid => { placed.add(sid); ordered.push(sid); });
                    }
                    placed.add(cid);
                    ordered.push(cid);
                    // Last sibling or middle sibling or first with right-direction: spouse on the right
                    if (sp.length > 0 && !(idx === 0 && sortedSiblings.length > 1 && (dir === 'left' || dir === null))) {
                        sp.forEach(sid => { placed.add(sid); ordered.push(sid); });
                    }
                });
            });

            // Any persons in this gen not yet placed (no parent in prev gen, e.g. married in)
            persons.forEach(p => {
                if (gen.get(p.id) === g && !placed.has(p.id)) {
                    placed.add(p.id);
                    ordered.push(p.id);
                }
            });

            genOrder.set(g, ordered);
        }

        // Now assign X positions per generation
        // Simple approach: lay out left to right with gaps, then center children under parents
        // We do two sub-passes:
        //   (a) Initial X: sequential left to right per generation
        //   (b) Adjust: center children under their parent couple midpoint

        // Sub-pass (a): initial sequential X
        for (let g = 0; g <= maxGen; g++) {
            const order = genOrder.get(g) || [];
            let x = 0;
            order.forEach((pid, i) => {
                // Use spouse gap if this person and prev person are spouses
                const prevPid = i > 0 ? order[i - 1] : null;
                const isSpouse = prevPid && spousesOf.get(pid).includes(prevPid);
                if (i > 0) x += isSpouse ? SPOUSE_GAP : CARD_GAP_X;
                positions.set(pid, { x, y: g * (CARD_H + GEN_GAP) });
                x += CARD_W;
            });
        }

        // Helper: build the group of children + their spouses for centering.
        // Blood children are ALWAYS included. Spouses are only included if
        // they are NOT a child of a different couple (those get centered by
        // their own parents). This prevents cross-family pulling.
        function buildChildGroup(c) {
            const group = [];
            c.children.forEach(cid => {
                group.push(cid);
                spousesOf.get(cid).forEach(sid => {
                    if (gen.get(sid) === gen.get(cid) && !group.includes(sid)) {
                        const isChildElsewhere = couples.some(c2 => c2 !== c && c2.children.includes(sid));
                        if (!isChildElsewhere) group.push(sid);
                    }
                });
            });
            return group;
        }

        // Sub-pass (b): center children under parents (iterate a few times to converge)
        for (let iter = 0; iter < 3; iter++) {
            // For each couple with children, compute parent midpoint and children midpoint,
            // then shift children to align
            couples.forEach(c => {
                if (c.children.length === 0) return;

                // Parent midpoint
                const pxs = c.members.map(m => positions.get(m)).filter(Boolean);
                if (pxs.length === 0) return;
                const parentMid = (Math.min(...pxs.map(p => p.x)) + Math.max(...pxs.map(p => p.x)) + CARD_W) / 2;

                const childGroup = buildChildGroup(c);

                const cxs = childGroup.map(cid => positions.get(cid)).filter(Boolean);
                if (cxs.length === 0) return;
                const childMid = (Math.min(...cxs.map(p => p.x)) + Math.max(...cxs.map(p => p.x)) + CARD_W) / 2;

                const shift = parentMid - childMid;
                if (Math.abs(shift) > 1) {
                    childGroup.forEach(cid => {
                        const pos = positions.get(cid);
                        if (pos) pos.x += shift;
                    });
                }
            });

            // After shifting, resolve overlaps in each generation
            // Keep spouse pairs locked together during overlap resolution
            for (let g = 0; g <= maxGen; g++) {
                const order = genOrder.get(g) || [];
                // Walk in genOrder sequence — never re-sort by X
                const items = order.map(pid => ({ id: pid, x: positions.get(pid).x }));
                for (let i = 1; i < items.length; i++) {
                    const prevIsSpouse = spousesOf.get(items[i].id).includes(items[i - 1].id);
                    const minGap = prevIsSpouse ? SPOUSE_GAP : CARD_GAP_X;
                    const minX = items[i - 1].x + CARD_W + minGap;
                    if (items[i].x < minX) {
                        const push = minX - items[i].x;
                        for (let j = i; j < items.length; j++) {
                            items[j].x += push;
                            positions.get(items[j].id).x = items[j].x;
                        }
                    }
                }
                // Force spouses to be adjacent (snap to each other)
                items.forEach(item => {
                    const mySpouses = spousesOf.get(item.id) || [];
                    mySpouses.forEach(sid => {
                        const spos = positions.get(sid);
                        const myPos = positions.get(item.id);
                        if (!spos || !myPos || gen.get(sid) !== g) return;
                        const expectedGap = CARD_W + SPOUSE_GAP;
                        const actualGap = Math.abs(spos.x - myPos.x);
                        if (actualGap > expectedGap + 1) {
                            if (spos.x > myPos.x) {
                                spos.x = myPos.x + expectedGap;
                            } else {
                                spos.x = myPos.x - expectedGap;
                            }
                        }
                    });
                });
                // Re-resolve overlaps after spouse snap (snap can create new overlaps)
                const items2 = order.map(pid => ({ id: pid, x: positions.get(pid).x }));
                for (let i = 1; i < items2.length; i++) {
                    const prevIsSpouse = spousesOf.get(items2[i].id).includes(items2[i - 1].id);
                    const minGap = prevIsSpouse ? SPOUSE_GAP : CARD_GAP_X;
                    const minX = items2[i - 1].x + CARD_W + minGap;
                    if (items2[i].x < minX) {
                        const push = minX - items2[i].x;
                        for (let j = i; j < items2.length; j++) {
                            items2[j].x += push;
                            positions.get(items2[j].id).x = items2[j].x;
                        }
                    }
                }
            }
        }

        // Final compaction: close unnecessary large gaps in each generation
        // For each pair of adjacent cards, if the gap is much larger than needed,
        // shift the right card (and everything after) left
        for (let g = 0; g <= maxGen; g++) {
            const order = genOrder.get(g) || [];
            const items = order.map(pid => ({ id: pid, x: positions.get(pid).x }));
            for (let i = 1; i < items.length; i++) {
                const prevIsSpouse = spousesOf.get(items[i].id).includes(items[i - 1].id);
                const idealGap = prevIsSpouse ? SPOUSE_GAP : CARD_GAP_X;
                const idealX = items[i - 1].x + CARD_W + idealGap;
                if (items[i].x > idealX + 1) {
                    const pull = items[i].x - idealX;
                    for (let j = i; j < items.length; j++) {
                        items[j].x -= pull;
                        positions.get(items[j].id).x = items[j].x;
                    }
                }
            }
        }

        // Re-center children under parents after compaction (1 pass)
        couples.forEach(c => {
            if (c.children.length === 0) return;
            const pxs = c.members.map(m => positions.get(m)).filter(Boolean);
            if (pxs.length === 0) return;
            const parentMid = (Math.min(...pxs.map(p => p.x)) + Math.max(...pxs.map(p => p.x)) + CARD_W) / 2;
            const childGroup = buildChildGroup(c);
            const cxs = childGroup.map(cid => positions.get(cid)).filter(Boolean);
            if (cxs.length === 0) return;
            const childMid = (Math.min(...cxs.map(p => p.x)) + Math.max(...cxs.map(p => p.x)) + CARD_W) / 2;
            const shift = parentMid - childMid;
            if (Math.abs(shift) > 1) {
                childGroup.forEach(cid => {
                    const pos = positions.get(cid);
                    if (pos) pos.x += shift;
                });
            }
        });

        // Final overlap resolution
        for (let g = 0; g <= maxGen; g++) {
            const order = genOrder.get(g) || [];
            const items = order.map(pid => ({ id: pid, x: positions.get(pid).x }));
            for (let i = 1; i < items.length; i++) {
                const prevIsSpouse = spousesOf.get(items[i].id).includes(items[i - 1].id);
                const minGap = prevIsSpouse ? SPOUSE_GAP : CARD_GAP_X;
                const minNextX = items[i - 1].x + CARD_W + minGap;
                if (items[i].x < minNextX) {
                    const push = minNextX - items[i].x;
                    for (let j = i; j < items.length; j++) {
                        items[j].x += push;
                        positions.get(items[j].id).x = items[j].x;
                    }
                }
            }
        }

        // Center around 0,0
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        positions.forEach(pos => {
            minX = Math.min(minX, pos.x);
            minY = Math.min(minY, pos.y);
            maxX = Math.max(maxX, pos.x + CARD_W);
            maxY = Math.max(maxY, pos.y + CARD_H);
        });
        const offX = -(minX + maxX) / 2;
        const offY = -(minY + maxY) / 2;
        positions.forEach(pos => { pos.x += offX; pos.y += offY; });

        return positions;
    }

    function computeLinks(persons, positions) {
        const links = [];
        const byId = new Map();
        persons.forEach(p => byId.set(p.id, p));

        // Build spouse clusters and track which couples have children
        const spousesOf = new Map();
        persons.forEach(p => {
            spousesOf.set(p.id, (p.rels || {}).spouses || []);
        });

        // ── 1. Spouse lines (short horizontal between near edges) ──
        const drawnSpouse = new Set();
        persons.forEach(p => {
            const pos = positions.get(p.id);
            if (!pos) return;
            (spousesOf.get(p.id) || []).forEach(sid => {
                const key = [p.id, sid].sort().join('-');
                if (drawnSpouse.has(key)) return;
                drawnSpouse.add(key);
                const sp = positions.get(sid);
                if (!sp) return;
                // Connect near edges at vertical midpoint
                const y = pos.y + CARD_H / 2;
                const leftP = pos.x < sp.x ? pos : sp;
                const rightP = pos.x < sp.x ? sp : pos;
                const x1 = leftP.x + CARD_W;
                const x2 = rightP.x;
                links.push({ path: `M ${x1} ${y} L ${x2} ${y}`, type: 'spouse', ids: [p.id, sid] });
            });
        });

        // ── 2. Parent→children lines (one branch per parent PAIR, not per cluster) ──
        // Group children by their unique parent pair (e.g. Ahmed+Fatima, Ahmed+Test test2)
        const parentPairs = new Map(); // "p1-p2" → { parents: [p1,p2], children: [cids] }

        persons.forEach(p => {
            const r = p.rels || {};
            const pids = [];
            if (r.father) pids.push(r.father);
            if (r.mother) pids.push(r.mother);
            if (pids.length === 0) return;

            // Create a key for this parent pair (sorted for consistency)
            const key = pids.length === 2 ? pids.sort().join('-') : pids[0];
            if (!parentPairs.has(key)) {
                parentPairs.set(key, { parents: [...pids], children: [] });
            }
            parentPairs.get(key).children.push(p.id);
        });

        // Also handle children with only one listed parent via the parent's children list
        persons.forEach(p => {
            const r = p.rels || {};
            (r.children || []).forEach(cid => {
                // Check if this child already has a parent pair
                const child = byId.get(cid);
                if (!child) return;
                const cr = child.rels || {};
                if (cr.father || cr.mother) return; // already handled above
                // Single parent (no father/mother set on child, only in parent's children list)
                const key = p.id;
                if (!parentPairs.has(key)) {
                    parentPairs.set(key, { parents: [p.id], children: [] });
                }
                if (!parentPairs.get(key).children.includes(cid)) {
                    parentPairs.get(key).children.push(cid);
                }
            });
        });

        // Draw branch lines for each parent pair
        let branchGroupId = 0;
        // Collect all branches first so we can detect horizontal overlaps
        const branchBars = [];
        parentPairs.forEach(pair => {
            const parentPositions = pair.parents.map(pid => positions.get(pid)).filter(Boolean);
            if (parentPositions.length === 0) return;

            const pLeftX = Math.min(...parentPositions.map(p => p.x));
            const pRightX = Math.max(...parentPositions.map(p => p.x + CARD_W));
            const anchorX = (pLeftX + pRightX) / 2;
            const anchorY = pair.parents.length >= 2
                ? parentPositions[0].y + CARD_H / 2
                : parentPositions[0].y + CARD_H;

            const childPositions = pair.children.map(cid => positions.get(cid)).filter(Boolean);
            if (childPositions.length === 0) return;
            const childTopY = childPositions[0].y;
            const parentBottom = parentPositions[0].y + CARD_H;
            const baseMidY = (parentBottom + childTopY) / 2;

            // Check if this bar's X range would touch/overlap a previous bar at the same baseMidY
            const childXs = childPositions.map(cp => cp.x + CARD_W / 2);
            const allXPoints = [...childXs, anchorX];
            const barLeft = Math.min(...allXPoints);
            const barRight = Math.max(...allXPoints);
            let midY = baseMidY;
            const gap = 12; // vertical offset between overlapping bars
            for (const prev of branchBars) {
                if (Math.abs(prev.midY - midY) < gap && barLeft <= prev.right + 30 && barRight >= prev.left - 30) {
                    midY = prev.midY + gap;
                }
            }
            branchBars.push({ midY, left: barLeft, right: barRight });
            // All segments in this parent-pair share a group for hover highlighting
            const group = `branch-${branchGroupId++}`;
            const allPersons = [...new Set([...pair.parents, ...pair.children])];

            // Vertical drop from anchor to midY
            links.push({ path: `M ${anchorX} ${anchorY} L ${anchorX} ${midY}`, type: 'parent-child', ids: allPersons, group });

            // Horizontal bar
            if (barRight - barLeft > 0.5) {
                links.push({ path: `M ${barLeft} ${midY} L ${barRight} ${midY}`, type: 'parent-child', ids: allPersons, group });
            }

            // Vertical drops to each child
            pair.children.forEach((cid, i) => {
                const cx = childXs[i];
                if (cx !== undefined) {
                    links.push({ path: `M ${cx} ${midY} L ${cx} ${childTopY}`, type: 'parent-child', ids: allPersons, group });
                }
            });
        });

        return links;
    }

    function renderTree(container, persons, unions, cardHtmlFn, onCardClick) {
        container.innerHTML = '';
        if (!persons || !persons.length) return null;

        // ── Measure actual card height BEFORE computing layout ──
        // Create a temporary offscreen card with the same width, measure its offsetHeight,
        // then remove it. offsetHeight forces a synchronous reflow so the value is accurate.
        const probe = document.createElement('div');
        probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:${CARD_W}px;`;
        probe.className = 'tree-card';
        probe.innerHTML = cardHtmlFn(persons[0]);
        container.appendChild(probe);
        const probeH = probe.offsetHeight;
        container.removeChild(probe);
        if (probeH > 0) CARD_H = probeH;

        const positions = computeLayout(persons);

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden;';
        container.appendChild(wrapper);

        const svg = d3.select(wrapper).append('svg')
            .attr('width', '100%').attr('height', '100%')
            .style('position', 'absolute').style('top', '0').style('left', '0')
            .style('pointer-events', 'none');
        const svgG = svg.append('g').attr('class', 'links-layer');

        const cardsLayer = document.createElement('div');
        cardsLayer.className = 'cards-layer';
        cardsLayer.style.cssText = 'position:absolute;top:0;left:0;transform-origin:0 0;';
        wrapper.appendChild(cardsLayer);

        const byId = new Map();
        persons.forEach(p => byId.set(p.id, p));
        positions.forEach((pos, pid) => {
            const person = byId.get(pid);
            if (!person) return;
            const card = document.createElement('div');
            card.className = 'tree-card';
            card.dataset.id = pid;
            card.style.cssText = `position:absolute;left:${pos.x}px;top:${pos.y}px;width:${CARD_W}px;`;
            card.innerHTML = cardHtmlFn(person);
            card.addEventListener('click', e => {
                if (e.target.closest('.connector-dot')) return;
                onCardClick(pid, e);
            });
            cardsLayer.appendChild(card);
        });

        const links = computeLinks(persons, positions);
        renderLinks(svgG, links);
        fitToViewport(wrapper, svg, svgG, cardsLayer, positions);
        return { positions, links, zoom: null, wrapper };
    }

    function renderLinks(svgG, links) {
        let linkIdx = 0;
        links.forEach(l => {
            const lid = `link-${linkIdx++}`;
            const visPath = svgG.append('path').attr('d', l.path)
                .attr('class', `tree-link tree-link-${l.type}`)
                .attr('data-lid', lid)
                .attr('fill', 'none').attr('stroke', document.body.classList.contains('dark-mode') ? '#475569' : '#94a3b8').attr('stroke-width', 2);
            if (l.group) visPath.attr('data-group', l.group);

            if (l.ids && l.ids.length > 0) {
                const hitPath = svgG.append('path').attr('d', l.path)
                    .attr('class', 'tree-link-hit')
                    .attr('data-lid', lid)
                    .attr('fill', 'none').attr('stroke', 'transparent').attr('stroke-width', 16)
                    .attr('data-persons', l.ids.join(','))
                    .attr('data-link-type', l.type)
                    .style('pointer-events', 'stroke')
                    .style('cursor', 'pointer');
                if (l.group) hitPath.attr('data-group', l.group);
                hitPath
                    .on('mouseenter', function () {
                        const group = this.getAttribute('data-group');
                        const hoverColor = document.body.classList.contains('dark-mode') ? '#60a5fa' : '#2563eb';
                        if (group) {
                            svgG.selectAll(`.tree-link[data-group="${group}"]`).attr('stroke', hoverColor).attr('stroke-width', 3).raise();
                            svgG.selectAll(`.tree-link-hit[data-group="${group}"]`).raise();
                        } else {
                            const myLid = this.getAttribute('data-lid');
                            svgG.select(`.tree-link[data-lid="${myLid}"]`).attr('stroke', hoverColor).attr('stroke-width', 3).raise();
                            d3.select(this).raise();
                        }
                    })
                    .on('mouseleave', function () {
                        const group = this.getAttribute('data-group');
                        const defaultColor = document.body.classList.contains('dark-mode') ? '#475569' : '#94a3b8';
                        if (group) svgG.selectAll(`.tree-link[data-group="${group}"]`).attr('stroke', defaultColor).attr('stroke-width', 2);
                        else {
                            const myLid = this.getAttribute('data-lid');
                            svgG.select(`.tree-link[data-lid="${myLid}"]`).attr('stroke', defaultColor).attr('stroke-width', 2);
                        }
                    })
                    .on('click', function () {
                        const persons = this.getAttribute('data-persons');
                        const linkType = this.getAttribute('data-link-type');
                        if (persons && window._openProofPanel) {
                            window._openProofPanel(persons.split(','), linkType);
                        }
                    });
            }
        });
    }

    function fitToViewport(wrapper, svg, svgG, cardsLayer, positions) {
        const zoom = d3.zoom().scaleExtent([0.15, 3]).on('zoom', event => {
            const { x, y, k } = event.transform;
            cardsLayer.style.transform = `translate(${x}px,${y}px) scale(${k})`;
            svgG.attr('transform', `translate(${x},${y}) scale(${k})`);
        });
        d3.select(wrapper).call(zoom);
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        positions.forEach(pos => {
            bx0 = Math.min(bx0, pos.x); by0 = Math.min(by0, pos.y);
            bx1 = Math.max(bx1, pos.x + CARD_W); by1 = Math.max(by1, pos.y + CARD_H);
        });
        const cw = bx1 - bx0, ch = by1 - by0;
        const wr = wrapper.getBoundingClientRect();
        const sc = Math.min((wr.width - 80) / cw, (wr.height - 140) / ch, 1);
        const tx = (wr.width - cw * sc) / 2 - bx0 * sc;
        const ty = (wr.height - ch * sc) / 2 - by0 * sc + 30;
        d3.select(wrapper).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(sc));
    }

    window.TreeLayout = { computeLayout, computeLinks, renderTree };
})();
