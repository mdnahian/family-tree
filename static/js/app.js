/* ── Family Tree — Frontend ───────────────────────────────── */
(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────
    let currentUser = null;
    let chart = null;
    let treeData = null;
    let unionsLookup = {};
    let allPersons = [];

    // ── Init ─────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', async () => {
        await loadCurrentUser();
        // Set CloudFront signed cookies if S3 backend is active
        fetch('/api/auth/media-cookie').catch(() => {});
        await initChart();
        loadNotifications();
        setupEventListeners();
        handleInitialRoute();
    });

    async function loadCurrentUser() {
        const resp = await fetch('/api/me');
        currentUser = await resp.json();
        const el = document.getElementById('userName');
        if (currentUser.person_name) {
            el.textContent = currentUser.person_name;
            el.onclick = () => {
                if (currentUser.person_slug) {
                    navigateToSlug(currentUser.person_slug);
                }
            };
        } else {
            el.textContent = currentUser.email;
        }
    }

    // ── Tree ─────────────────────────────────────────────────
    async function initChart() {
        const resp = await fetch('/api/tree');
        const data = await resp.json();
        treeData = data.persons || [];
        unionsLookup = data.unions || {};
        allPersons = treeData.map(p => ({ id: p.id, ...p.data }));

        const cont = document.getElementById('FamilyChart');
        if (treeData.length === 0) {
            cont.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">&#x1F333;</div>
                    <div class="empty-state-text">No one in the family tree yet.</div>
                    <button class="btn btn-primary" id="btnEmptyAdd">Add First Person</button>
                </div>`;
            document.getElementById('btnEmptyAdd').onclick = () => showAddPersonModal();
            return;
        }

        // Wait for web fonts before rendering so card height measurement is accurate
        if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
        }

        // Render tree using custom layout engine (shows ALL nodes, stable positions)
        chart = TreeLayout.renderTree(cont, treeData, unionsLookup, cardHtml, onCardClick);

        // Event delegation for connector dots
        cont.addEventListener('click', (e) => {
            const dot = e.target.closest('.connector-dot');
            if (!dot) return;
            e.stopPropagation();
            e.preventDefault();
            const personId = dot.dataset.personId;
            const rel = dot.dataset.rel;
            const cls = dot.dataset.pos;
            if (personId) showDotPopover(e, personId, rel, cls);
        });
    }

    function cardHtml(person) {
        const d = person.data || {};
        const pid = person.id;
        const name = `${d['first name'] || ''} ${d['last name'] || ''}`.trim() || 'Unknown';
        const avatar = d.avatar
            ? `<img class="card-photo" src="${d.avatar}" alt="">`
            : `<div class="card-photo-placeholder">${(d['first name'] || '?')[0].toUpperCase()}</div>`;
        const ownerBadge = d.has_owner ? '<span class="card-owner-badge" title="Active member"></span>' : '';

        // Always show all 3 lines: birth year, occupation — use &nbsp; as placeholder to keep consistent height
        const birthYear = d.birth_year ? `b. ${d.birth_year}` : '-';
        const occupation = d.occupation || '-';

        const dots = `
            <div class="connector-dot dot-top" data-person-id="${pid}" data-rel="parent" data-pos="dot-top"></div>
            <div class="connector-dot dot-bottom" data-person-id="${pid}" data-rel="child" data-pos="dot-bottom"></div>
            <div class="connector-dot dot-left" data-person-id="${pid}" data-rel="spouse" data-pos="dot-left"></div>
            <div class="connector-dot dot-right" data-person-id="${pid}" data-rel="spouse" data-pos="dot-right"></div>
        `;

        return `<div class="card-inner">${dots}<div class="person-card">${avatar}<div class="card-info"><div class="card-name">${name}${ownerBadge}</div><div class="card-detail">${birthYear}</div><div class="card-detail">${occupation}</div></div></div></div>`;
    }

    function onCardClick(personId, e) {
        const person = allPersons.find(p => p.id === personId);
        const slug = person ? person.slug : null;
        if (slug) {
            history.pushState({ slug }, '', `/person/${slug}`);
        }
        selectCard(personId);
        openPersonPanel(personId);
    }

    function selectCard(personId) {
        // Remove previous selection
        document.querySelectorAll('.tree-card.selected').forEach(el => el.classList.remove('selected'));
        // Add to new
        const card = document.querySelector(`.tree-card[data-id="${personId}"]`);
        if (card) card.classList.add('selected');
    }

    // ── Connector Dot Popover ────────────────────────────────
    function showDotPopover(e, personId, defaultRel, dotClass) {
        hideDotPopover();
        const popover = document.getElementById('dotPopover');
        const body = popover.querySelector('.dot-popover-body');

        // Build menu items based on which dot was clicked
        const items = [];
        if (dotClass === 'dot-top') {
            items.push({ label: 'Add Father', icon: 'M', rel: 'parent', gender: 'M' });
            items.push({ label: 'Add Mother', icon: 'F', rel: 'parent', gender: 'F' });
        } else if (dotClass === 'dot-bottom') {
            items.push({ label: 'Add Son', icon: 'M', rel: 'child', gender: 'M' });
            items.push({ label: 'Add Daughter', icon: 'F', rel: 'child', gender: 'F' });
        } else {
            items.push({ label: 'Add Husband', icon: 'M', rel: 'spouse', gender: 'M' });
            items.push({ label: 'Add Wife', icon: 'F', rel: 'spouse', gender: 'F' });
        }

        body.innerHTML = '';
        items.forEach(item => {
            const el = document.createElement('div');
            el.className = 'dot-popover-item';
            const genderIcon = item.gender === 'M'
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="14" r="5"/><line x1="19" y1="5" x2="13.6" y2="10.4"/><line x1="19" y1="5" x2="14" y2="5"/><line x1="19" y1="5" x2="19" y2="10"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="5"/><line x1="12" y1="13" x2="12" y2="21"/><line x1="9" y1="18" x2="15" y2="18"/></svg>';
            el.innerHTML = `${genderIcon}<span>${item.label}</span>`;
            el.onclick = () => {
                hideDotPopover();
                quickAddRelative(personId, item.rel, item.gender);
            };
            body.appendChild(el);
        });

        // Also add "Link existing person"
        const linkEl = document.createElement('div');
        linkEl.className = 'dot-popover-item';
        linkEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span>Link existing...</span>`;
        linkEl.onclick = () => {
            hideDotPopover();
            showAddRelativeModal(personId);
        };
        body.appendChild(linkEl);

        // Position near the clicked dot
        popover.classList.remove('hidden');
        const rect = e.target.getBoundingClientRect();
        let top = rect.bottom + 6;
        let left = rect.left - 60;
        // Keep in viewport
        if (top + 200 > window.innerHeight) top = rect.top - 200;
        if (left + 180 > window.innerWidth) left = window.innerWidth - 190;
        if (left < 4) left = 4;
        popover.style.top = top + 'px';
        popover.style.left = left + 'px';
    }

    function hideDotPopover() {
        document.getElementById('dotPopover').classList.add('hidden');
    }

    // Quick-add a relative: create a new person with gender preset, then link
    async function quickAddRelative(personId, relType, gender) {
        const overlay = document.getElementById('modalOverlay');
        const content = document.getElementById('modalContent');
        const person = allPersons.find(p => p.id === String(personId));
        const personName = person ? `${person['first name']} ${person['last name'] || ''}`.trim() : '';
        const relLabel = { parent: 'Parent', child: 'Child', spouse: 'Spouse' }[relType];

        content.innerHTML = `
            <div class="modal-title">Add ${relLabel} for ${escapeHtml(personName)}</div>
            <form id="quickAddForm">
                <div class="form-row">
                    <div class="form-group"><label>First Name *</label><input name="first_name" required autofocus></div>
                    <div class="form-group"><label>Last Name</label><input name="last_name"></div>
                </div>
                <input type="hidden" name="gender" value="${gender}">
                <div class="form-row">
                    <div class="form-group"><label>Birth Year</label><input name="birth_year" type="number" min="1800" max="2100" placeholder="e.g. 1990"></div>
                    <div class="form-group"><label>Current City</label><input name="current_city"></div>
                </div>
                ${relType === 'spouse' ? '<div class="form-group"><label>Marriage Date</label><input name="marriage_date" type="date"></div>' : ''}
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="window._closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary">Add</button>
                </div>
            </form>`;
        overlay.classList.remove('hidden');

        document.getElementById('quickAddForm').onsubmit = async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const data = {};
            fd.forEach((v, k) => { data[k] = v; });
            const marriageDate = data.marriage_date;
            delete data.marriage_date;

            // Create person
            const resp = await fetch('/api/persons', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (!resp.ok) { alert('Failed to create person'); return; }
            const newPerson = await resp.json();

            // Create relationship
            if (relType === 'child') {
                await fetch('/api/parent-child', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ parent_id: personId, child_id: newPerson.id }),
                });
                closeModal();
                await refreshTree();
                // Offer to link the other parent
                showLinkOtherParentModal(personId, newPerson.id, newPerson.first_name);
                return;
            } else if (relType === 'parent') {
                await fetch('/api/parent-child', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ parent_id: newPerson.id, child_id: personId }),
                });
            } else if (relType === 'spouse') {
                const body = { partner1_id: personId, partner2_id: newPerson.id };
                if (marriageDate) body.marriage_date = marriageDate;
                await fetch('/api/unions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
            }

            closeModal();
            await refreshTree();
            navigateToPersonId(personId);
        };
    }

    // After adding a child, offer to link the other parent
    function showLinkOtherParentModal(parentId, childId, childName) {
        const overlay = document.getElementById('modalOverlay');
        const content = document.getElementById('modalContent');
        const parentPerson = allPersons.find(p => p.id === String(parentId));
        const parentGender = parentPerson ? parentPerson.gender : '';
        const otherLabel = parentGender === 'M' ? 'mother' : parentGender === 'F' ? 'father' : 'other parent';

        content.innerHTML = `
            <div class="modal-title">Link ${otherLabel} for ${escapeHtml(childName)}</div>
            <p style="margin-bottom:16px;color:var(--text-secondary);font-size:14px">
                Would you like to add or link the ${otherLabel}?
            </p>
            <div class="form-group">
                <label>Search existing person</label>
                <input type="text" id="otherParentSearch" placeholder="Type a name..." autocomplete="off">
                <div id="otherParentResults" style="margin-top:4px"></div>
            </div>
            <div style="text-align:center;color:var(--text-secondary);font-size:13px;margin:12px 0">or</div>
            <button class="btn btn-secondary" style="width:100%" id="createOtherParentBtn">Create new person as ${otherLabel}</button>
            <div class="form-actions" style="margin-top:16px">
                <button class="btn btn-text" onclick="window._closeModal()">Skip</button>
            </div>`;
        overlay.classList.remove('hidden');

        // Search existing
        let timeout;
        document.getElementById('otherParentSearch').addEventListener('input', function () {
            clearTimeout(timeout);
            const q = this.value.trim();
            const results = document.getElementById('otherParentResults');
            if (q.length < 2) { results.innerHTML = ''; return; }
            timeout = setTimeout(async () => {
                const resp = await fetch('/api/persons?q=' + encodeURIComponent(q));
                const persons = await resp.json();
                results.innerHTML = '';
                for (const p of persons.filter(pp => pp.id !== parentId && pp.id !== childId).slice(0, 8)) {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';
                    item.textContent = `${p.first_name} ${p.last_name || ''}`.trim();
                    item.onclick = async () => {
                        // Link as parent + create union with original parent
                        await fetch('/api/parent-child', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ parent_id: p.id, child_id: childId }),
                        });
                        // Also create a union between the two parents if not already linked
                        await fetch('/api/unions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ partner1_id: parentId, partner2_id: p.id }),
                        }).catch(() => {}); // ignore if union already exists
                        closeModal();
                        await refreshTree();
                        navigateToPersonId(parentId);
                    };
                    results.appendChild(item);
                }
            }, 300);
        });

        // Create new
        document.getElementById('createOtherParentBtn').onclick = () => {
            closeModal();
            const otherGender = parentGender === 'M' ? 'F' : parentGender === 'F' ? 'M' : '';
            quickAddOtherParent(parentId, childId, otherGender);
        };
    }

    // Quick-add the other parent: create person, link as parent, create union
    async function quickAddOtherParent(existingParentId, childId, gender) {
        const overlay = document.getElementById('modalOverlay');
        const content = document.getElementById('modalContent');
        const otherLabel = gender === 'M' ? 'Father' : gender === 'F' ? 'Mother' : 'Parent';

        content.innerHTML = `
            <div class="modal-title">Add ${otherLabel}</div>
            <form id="otherParentForm">
                <div class="form-row">
                    <div class="form-group"><label>First Name *</label><input name="first_name" required autofocus></div>
                    <div class="form-group"><label>Last Name</label><input name="last_name"></div>
                </div>
                <input type="hidden" name="gender" value="${gender}">
                <div class="form-row">
                    <div class="form-group"><label>Date of Birth</label><input name="date_of_birth" type="date"></div>
                    <div class="form-group"><label>Current City</label><input name="current_city"></div>
                </div>
                <div class="form-group"><label>Marriage Date</label><input name="marriage_date" type="date"></div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="window._closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary">Add</button>
                </div>
            </form>`;
        overlay.classList.remove('hidden');

        document.getElementById('otherParentForm').onsubmit = async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const data = {};
            fd.forEach((v, k) => { data[k] = v; });
            const marriageDate = data.marriage_date;
            delete data.marriage_date;

            const resp = await fetch('/api/persons', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (!resp.ok) { alert('Failed to create person'); return; }
            const newPerson = await resp.json();

            // Link as parent of the child
            await fetch('/api/parent-child', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parent_id: newPerson.id, child_id: childId }),
            });

            // Create union between the two parents
            const unionBody = { partner1_id: existingParentId, partner2_id: newPerson.id };
            if (marriageDate) unionBody.marriage_date = marriageDate;
            await fetch('/api/unions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(unionBody),
            }).catch(() => {});

            closeModal();
            await refreshTree();
            navigateToPersonId(existingParentId);
        };
    }

    async function refreshTree() {
        await initChart();
    }

    function navigateToPersonId(personId) {
        selectCard(personId);
        openPersonPanel(personId);
    }

    function navigateToSlug(slug) {
        history.pushState({ slug }, '', `/person/${slug}`);
        fetch(`/api/persons/by-slug/${slug}`)
            .then(r => r.json())
            .then(person => {
                if (person.id) navigateToPersonId(person.id);
            });
    }

    // ── URL Routing ──────────────────────────────────────────
    function handleInitialRoute() {
        const path = window.location.pathname;
        const match = path.match(/^\/person\/(.+)$/);
        if (match) {
            navigateToSlug(match[1]);
        } else if (currentUser.role === 'member' && currentUser.person_slug) {
            navigateToSlug(currentUser.person_slug);
        }
    }

    window.addEventListener('popstate', (e) => {
        if (e.state && e.state.slug) {
            navigateToSlug(e.state.slug);
        } else {
            closePanel();
        }
    });

    // ── Side Panel ───────────────────────────────────────────
    function openPanel(title) {
        const panel = document.getElementById('sidePanel');
        document.getElementById('panelTitle').textContent = title;
        panel.classList.remove('hidden');
    }

    function closePanel() {
        document.getElementById('sidePanel').classList.add('hidden');
        document.getElementById('panelContent').innerHTML = '';
        document.querySelectorAll('.tree-card.selected').forEach(el => el.classList.remove('selected'));
        if (window.location.pathname !== '/') {
            history.pushState(null, '', '/');
        }
    }

    async function openPersonPanel(personId) {
        const resp = await fetch(`/api/persons/${personId}`);
        const person = await resp.json();
        openPanel(person.first_name + ' ' + (person.last_name || ''));
        const content = document.getElementById('panelContent');

        // ── Build RIGHT sidebar (Wikipedia-style infobox) ──
        const photoHtml = person.profile_photo
            ? `<img class="infobox-photo" src="${person.profile_photo}" alt="">`
            : `<div class="infobox-photo-placeholder">${(person.first_name || '?')[0].toUpperCase()}</div>`;

        let infobox = `<div class="infobox">
            ${photoHtml}
            <div class="infobox-name">${person.first_name} ${person.last_name || ''}</div>
            ${person.nickname ? `<div class="infobox-nickname">"${person.nickname}"</div>` : ''}
            <div class="infobox-rows">
                ${infoRow('Gender', { M: 'Male', F: 'Female', O: 'Other' }[person.gender] || '')}
                ${person.birth_year ? infoRow('Birth Year', String(person.birth_year)) : ''}
                ${infoRow('Occupation', person.occupation)}
                ${infoRow('Location', [person.current_city, person.current_country].filter(Boolean).join(', '))}
                ${person.latest_school ? infoRow('School', person.latest_school) : ''}`;

        if (person.access !== 'limited') {
            if (person.date_of_birth) infobox += infoRow('Born', person.date_of_birth);
            if (person.date_of_death) infobox += infoRow('Died', person.date_of_death);
            if (person.birth_city || person.birth_country) infobox += infoRow('Birthplace', [person.birth_city, person.birth_country].filter(Boolean).join(', '));
            if (person.phone_number) infobox += infoRow('Phone', person.phone_number);
        }
        infobox += `</div>`; // close infobox-rows

        // Relationships inside infobox
        if (person.access !== 'limited') {
            // Parents
            if (person.parent_links && person.parent_links.length) {
                infobox += `<div class="infobox-section"><div class="infobox-section-title">Parents</div>`;
                for (const pc of person.parent_links) {
                    const parentName = lookupPersonName(pc.parent_id);
                    infobox += `<div class="relation-link" onclick="window._navigateToPerson(${pc.parent_id})"><div>${escapeHtml(parentName)}</div><div class="relation-type">${pc.relation_type || 'biological'}</div></div>`;
                }
                infobox += `</div>`;
            }
            // Siblings
            const myParentIds = new Set((person.parent_links || []).map(pc => String(pc.parent_id)));
            const siblingSharedParents = new Map();
            (person.parent_links || []).forEach(pc => {
                const parentNode = treeData.find(n => n.id === String(pc.parent_id));
                if (parentNode && parentNode.rels) {
                    (parentNode.rels.children || []).forEach(cid => {
                        if (cid !== String(person.id)) siblingSharedParents.set(cid, (siblingSharedParents.get(cid) || 0) + 1);
                    });
                }
            });
            if (siblingSharedParents.size > 0) {
                infobox += `<div class="infobox-section"><div class="infobox-section-title">Siblings</div>`;
                siblingSharedParents.forEach((sharedCount, sid) => {
                    const sibName = lookupPersonName(sid);
                    const label = sharedCount < myParentIds.size ? 'half-sibling' : 'sibling';
                    infobox += `<div class="relation-link" onclick="window._navigateToPerson(${sid})"><div>${escapeHtml(sibName)}</div><div class="relation-type">${label}</div></div>`;
                });
                infobox += `</div>`;
            }
            // Spouses
            if (person.unions && person.unions.length) {
                infobox += `<div class="infobox-section"><div class="infobox-section-title">Marriages / Unions</div>`;
                for (const u of person.unions) {
                    const partnerId = u.partner1_id === person.id ? u.partner2_id : u.partner1_id;
                    const partnerName = lookupPersonName(partnerId);
                    const status = u.divorce_date ? `Divorced ${u.divorce_date}` : (u.is_current ? 'Current' : 'Ended');
                    infobox += `<div class="relation-link" onclick="window._navigateToPerson(${partnerId})"><div>${escapeHtml(partnerName)}</div><div class="relation-type">${u.union_type || 'marriage'} &middot; ${status}</div></div>`;
                }
                infobox += `</div>`;
            }
            // Children
            if (person.children_links && person.children_links.length) {
                infobox += `<div class="infobox-section"><div class="infobox-section-title">Children</div>`;
                for (const pc of person.children_links) {
                    const childName = lookupPersonName(pc.child_id);
                    infobox += `<div class="relation-link" onclick="window._navigateToPerson(${pc.child_id})"><div>${escapeHtml(childName)}</div><div class="relation-type">${pc.relation_type || 'biological'}</div></div>`;
                }
                infobox += `</div>`;
            }
        }

        // Action buttons inside infobox
        infobox += `<div class="infobox-actions">`;
        if (person.can_edit) {
            infobox += `<button class="btn btn-secondary btn-sm" onclick="window._editPerson(${person.id})">Edit</button>`;
            if (!person.has_owner && currentUser.role !== 'member') {
                infobox += `<button class="btn btn-secondary btn-sm" onclick="window._invitePerson(${person.id})">Invite</button>`;
            }
            infobox += `<button class="btn btn-secondary btn-sm" onclick="window._addRelative(${person.id})">Add Relative</button>`;
            infobox += `<button class="btn btn-danger btn-sm" onclick="window._deletePerson(${person.id}, '${escapeHtml(person.first_name + ' ' + (person.last_name || ''))}')">Delete</button>`;
        }
        if (person.has_owner && person.owner_id !== currentUser.id && currentUser.role !== 'admin') {
            const isFriend = currentUser.friend_ids && currentUser.friend_ids.includes(person.owner_id);
            if (isFriend) {
                infobox += `<button class="btn btn-danger btn-sm" onclick="window._unfriend(${person.owner_id})">Unfriend</button>`;
            } else {
                infobox += `<button class="btn btn-friend btn-sm" onclick="window._sendFriendRequest(${person.owner_id})">Send Friend Request</button>`;
            }
        }
        infobox += `</div></div>`; // close infobox-actions + infobox

        // ── Build LEFT content (bio + links + gallery) ──
        let main = '';

        if (person.access === 'limited') {
            main += `<div class="panel-limited-msg">Send a friend request to see more details about this person and their family.</div>`;
            if (person.has_owner && person.owner_id !== currentUser.id && currentUser.role !== 'admin') {
                const isFriend = currentUser.friend_ids && currentUser.friend_ids.includes(person.owner_id);
                if (!isFriend) {
                    main += `<button class="btn btn-friend" onclick="window._sendFriendRequest(${person.owner_id})">Send Friend Request</button>`;
                }
            }
        } else {
            if (person.biography) {
                main += `<div class="panel-section"><div class="panel-bio">${escapeHtml(person.biography)}</div></div>`;
            }
            if (person.external_urls) {
                try {
                    const urls = JSON.parse(person.external_urls);
                    if (Array.isArray(urls) && urls.length) {
                        main += `<div class="panel-section"><div class="panel-section-title">Links</div>`;
                        urls.forEach(u => { main += `<div><a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a></div>`; });
                        main += `</div>`;
                    }
                } catch (e) {
                    if (person.external_urls && person.external_urls.startsWith('http')) {
                        main += `<div class="panel-section"><div class="panel-section-title">Links</div><div><a href="${escapeHtml(person.external_urls)}" target="_blank" rel="noopener">${escapeHtml(person.external_urls)}</a></div></div>`;
                    }
                }
            }
            // Gallery (upload button is the first item in the grid)
            main += `<div class="panel-section gallery-section">
                <div class="gallery-search-wrap">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input type="text" class="gallery-search" id="gallerySearch" placeholder="Search photos..." autocomplete="off">
                </div>
                <div id="mediaGallery" class="gallery-grid">
                    ${person.can_edit ? `<label class="gallery-upload-btn"><input type="file" hidden id="mediaUpload" accept="image/*,.pdf,.doc,.docx" multiple><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>Upload</span></label>` : ''}
                </div>
            </div>`;
        }

        // ── Assemble two-column Wikipedia layout ──
        content.innerHTML = `<div class="wiki-layout"><div class="wiki-main">${main}</div>${infobox}</div>`;

        // Wire up gallery
        if (person.access !== 'limited') {
            loadMediaGallery(person.id);
            const gallerySearchInput = document.getElementById('gallerySearch');
            if (gallerySearchInput) {
                let searchTimeout;
                gallerySearchInput.addEventListener('input', () => {
                    clearTimeout(searchTimeout);
                    searchTimeout = setTimeout(() => filterGallery(gallerySearchInput.value.trim()), 300);
                });
            }
            const uploadInput = document.getElementById('mediaUpload');
            if (uploadInput) {
                uploadInput.addEventListener('change', (e) => uploadMediaFiles(e.target.files, person.id));
            }
        }
    }

    async function openProofPanel(personIds, linkType) {
        // Accept array of IDs or two separate args for backwards compat
        if (!Array.isArray(personIds)) {
            personIds = [arguments[0], arguments[1]].filter(Boolean);
            linkType = linkType || 'spouse';
        }

        // Classify parents vs children for this branch
        const parents = [];
        const children = [];
        if (linkType === 'parent-child') {
            personIds.forEach(id => {
                const node = treeData.find(n => n.id === String(id));
                if (!node) return;
                const nodeChildren = node.rels.children || [];
                const hasChildInList = nodeChildren.some(cid => personIds.includes(cid) || personIds.includes(String(cid)));
                if (hasChildInList) parents.push(id);
                else children.push(id);
            });
        }

        // English list formatter: "A", "A and B", "A, B, and C"
        function joinList(items) {
            if (items.length === 0) return '';
            if (items.length === 1) return items[0];
            if (items.length === 2) return `${items[0]} and ${items[1]}`;
            return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
        }

        // Build descriptive subtitle with bold names
        let subtitle;
        const bold = (name) => `<strong>${escapeHtml(name)}</strong>`;
        if (linkType === 'spouse' || (linkType !== 'parent-child' && personIds.length === 2)) {
            const p1 = treeData.find(n => n.id === String(personIds[0]));
            const isSpouse = p1 && (p1.rels.spouses || []).includes(String(personIds[1]));
            if (isSpouse || linkType === 'spouse') {
                subtitle = joinList(personIds.map(id => bold(lookupPersonName(id))));
            } else {
                subtitle = `Parent ${bold(lookupPersonName(personIds[0]))} with their child ${bold(lookupPersonName(personIds[1]))}`;
            }
        } else if (linkType === 'parent-child' && parents.length > 0 && children.length > 0) {
            const parentBold = parents.map(id => bold(lookupPersonName(id)));
            const childBold = children.map(id => bold(lookupPersonName(id)));
            const pLabel = parents.length === 1 ? 'Parent' : 'Parents';
            const cLabel = children.length === 1 ? 'child' : 'children';
            subtitle = `${pLabel} ${joinList(parentBold)} with their ${cLabel} ${joinList(childBold)}`;
        } else {
            subtitle = joinList(personIds.map(id => bold(lookupPersonName(id))));
        }

        openPanel('Shared Moments');
        const content = document.getElementById('panelContent');

        let resp;
        if (linkType === 'spouse' || (personIds.length === 2 && linkType !== 'parent-child')) {
            // Spouse: show media where both are tagged
            resp = await fetch(`/api/media/shared/${personIds[0]}/${personIds[1]}`);
        } else if (linkType === 'parent-child' && parents.length > 0 && children.length > 0) {
            // Parent-child: show media where (any parent) AND (any child) are tagged
            resp = await fetch(`/api/media/shared-family?parents=${parents.join(',')}&children=${children.join(',')}`);
        } else {
            resp = await fetch(`/api/media/shared-multi?ids=${personIds.join(',')}`);
        }
        const media = resp.ok ? await resp.json() : [];

        let html = `<div class="proof-subtitle">${subtitle}</div><div class="panel-section">`;
        if (media.length === 0) {
            html += `<div style="text-align:center;color:var(--text-secondary);padding:32px 0">
                <div style="font-size:32px;opacity:0.3;margin-bottom:8px">&#128247;</div>
                <div>No shared photos yet.</div>
                <div style="font-size:13px;margin-top:4px">Upload images and tag both people to see them here.</div>
            </div>`;
        } else {
            html += '<div class="gallery-grid">';
            for (const m of media) {
                if (m.file_type === 'image') {
                    html += `<div class="gallery-item" data-media-id="${m.id}">
                        <img src="${m.file_url}" alt="${escapeHtml(m.title || m.original_filename || '')}" loading="lazy">
                        <div class="gallery-item-overlay">
                            <span class="gallery-item-title">${escapeHtml(m.title || '')}</span>
                        </div>
                    </div>`;
                } else {
                    html += `<div class="gallery-doc" data-media-url="${m.file_url}">
                        <div class="gallery-doc-icon">&#128196;</div>
                        <div>${escapeHtml(m.original_filename || m.file_type)}</div>
                    </div>`;
                }
            }
            html += '</div>';
        }
        html += '</div>';

        content.innerHTML = html;

        // Wire up click handlers
        content.querySelectorAll('.gallery-item').forEach(item => {
            const mid = item.dataset.mediaId;
            const m = media.find(mm => String(mm.id) === mid);
            if (m) item.onclick = () => openLightbox(m);
        });
        content.querySelectorAll('.gallery-doc').forEach(item => {
            item.onclick = () => window.open(item.dataset.mediaUrl, '_blank');
        });
    }

    async function openUnionPanel(unionId) {
        const resp = await fetch(`/api/unions/${unionId}`);
        const union = await resp.json();
        const p1Name = union.partner1 ? `${union.partner1.first_name} ${union.partner1.last_name || ''}`.trim() : '';
        const p2Name = union.partner2 ? `${union.partner2.first_name} ${union.partner2.last_name || ''}`.trim() : '';
        openPanel(`${p1Name} & ${p2Name}`);
        const content = document.getElementById('panelContent');
        let html = `
            <div class="panel-section">
                ${infoRow('Type', union.union_type || 'marriage')}
                ${union.marriage_date ? infoRow('Date', union.marriage_date) : ''}
                ${union.divorce_date ? infoRow('Divorced', union.divorce_date) : ''}
                ${infoRow('Status', union.is_current ? 'Current' : 'Ended')}
                ${union.marriage_city || union.marriage_country ? infoRow('Location', [union.marriage_city, union.marriage_country].filter(Boolean).join(', ')) : ''}
                ${union.notes ? infoRow('Notes', union.notes) : ''}
            </div>`;

        if (union.access === 'limited') {
            html += `<div class="panel-limited-msg">Send a friend request to see evidence and more details.</div>`;
        } else {
            html += `<div class="panel-section"><div class="panel-section-title">Evidence / Proof</div><div id="evidenceGallery" class="media-grid"></div>`;
            html += `<div style="margin-top:8px"><label class="btn btn-secondary btn-sm"><input type="file" hidden id="evidenceUpload" accept="image/*,.pdf,.doc,.docx" multiple> Upload Proof</label></div>`;
            html += `</div>`;
        }

        content.innerHTML = html;

        if (union.access !== 'limited' && union.evidence) {
            const gallery = document.getElementById('evidenceGallery');
            for (const ev of union.evidence) {
                if (ev.media) {
                    gallery.appendChild(createMediaThumb(ev.media));
                }
            }
            const evidenceUpload = document.getElementById('evidenceUpload');
            if (evidenceUpload) {
                evidenceUpload.addEventListener('change', (e) => uploadEvidenceFiles(e.target.files, unionId, null));
            }
        }
    }

    // ── Media Gallery (Google Photos style) ─────────────────
    let galleryState = { personId: null, items: [], total: 0, offset: 0, loading: false, query: '' };

    async function loadMediaGallery(personId) {
        const gallery = document.getElementById('mediaGallery');
        if (!gallery) return;
        galleryState = { personId, items: [], total: 0, offset: 0, loading: false, query: '' };
        // Preserve the upload button, remove only media items
        gallery.querySelectorAll('.gallery-item, .gallery-doc, .gallery-empty').forEach(el => el.remove());
        await fetchMoreMedia(gallery);

        // Setup infinite scroll
        const sentinel = document.createElement('div');
        sentinel.className = 'gallery-load-more';
        sentinel.id = 'gallerySentinel';
        gallery.parentElement.appendChild(sentinel);

        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !galleryState.loading && galleryState.offset < galleryState.total) {
                fetchMoreMedia(gallery);
            }
        }, { rootMargin: '200px' });
        observer.observe(sentinel);
    }

    async function fetchMoreMedia(gallery) {
        if (galleryState.loading) return;
        galleryState.loading = true;
        try {
            const q = galleryState.query ? `&q=${encodeURIComponent(galleryState.query)}` : '';
            const resp = await fetch(`/api/persons/${galleryState.personId}/media?offset=${galleryState.offset}&limit=20${q}`);
            if (!resp.ok) return;
            const data = await resp.json();
            galleryState.total = data.total;
            galleryState.items.push(...data.items);
            galleryState.offset += data.items.length;

            for (const m of data.items) {
                gallery.appendChild(createGalleryItem(m, galleryState.personId));
            }
            if (data.items.length === 0 && galleryState.offset === 0) {
                // Don't wipe gallery — upload button may be there. Append empty message instead.
                if (!gallery.querySelector('.gallery-empty')) {
                    const emptyMsg = document.createElement('div');
                    emptyMsg.className = 'gallery-empty';
                    emptyMsg.textContent = 'No photos yet';
                    gallery.appendChild(emptyMsg);
                }
            }
        } catch (e) { /* permission denied */ }
        galleryState.loading = false;
    }

    function createGalleryItem(m, personId) {
        if (m.file_type === 'image') {
            const isProfile = m.is_profile_photo;
            const item = document.createElement('div');
            item.className = 'gallery-item';
            if (isProfile) item.classList.add('is-profile');
            item.innerHTML = `
                <img src="${m.file_url}" alt="${escapeHtml(m.title || m.original_filename || '')}" loading="lazy">
                <div class="gallery-item-overlay">
                    <span class="gallery-item-title">${escapeHtml(m.title || '')}</span>
                    <div class="gallery-item-actions">
                        ${isProfile
                            ? `<button class="gallery-item-action" title="Remove as profile photo" data-action="unset-profile">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                               </button>`
                            : `<button class="gallery-item-action" title="Set as profile photo" data-action="profile">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                               </button>`
                        }
                        <button class="gallery-item-action gallery-item-delete" title="Delete image" data-action="delete">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>
                ${isProfile ? '<div class="gallery-profile-badge" title="Profile photo">&#9733;</div>' : ''}`;
            item.onclick = (e) => { if (!e.target.closest('.gallery-item-action')) openLightbox(m); };

            item.querySelector('[data-action="profile"], [data-action="unset-profile"]').onclick = async (e) => {
                e.stopPropagation();
                const action = e.currentTarget.dataset.action;
                if (action === 'profile') {
                    await fetch(`/api/media/${m.id}/set-profile/${personId}`, { method: 'PUT' });
                } else {
                    await fetch(`/api/persons/${personId}/unset-profile`, { method: 'PUT' });
                }
                await refreshTree();
                openPersonPanel(personId);
            };
            item.querySelector('[data-action="delete"]').onclick = async (e) => {
                e.stopPropagation();
                if (!confirm('Delete this image?')) return;
                await fetch(`/api/media/${m.id}`, { method: 'DELETE' });
                await refreshTree();
                openPersonPanel(personId);
            };
            return item;
        } else {
            const item = document.createElement('div');
            item.className = 'gallery-doc';
            item.innerHTML = `<div class="gallery-doc-icon">&#128196;</div><div>${escapeHtml(m.original_filename || m.file_type)}</div>
                <button class="gallery-item-action gallery-item-delete" title="Delete" data-action="delete-doc" style="position:absolute;top:4px;right:4px;opacity:0">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>`;
            item.style.position = 'relative';
            item.onclick = (e) => {
                if (e.target.closest('[data-action="delete-doc"]')) {
                    e.stopPropagation();
                    if (!confirm('Delete this document?')) return;
                    fetch(`/api/media/${m.id}`, { method: 'DELETE' }).then(() => openPersonPanel(personId));
                    return;
                }
                window.open(m.file_url, '_blank');
            };
            return item;
        }
    }

    function filterGallery(query) {
        galleryState.query = query;
        galleryState.offset = 0;
        galleryState.items = [];
        galleryState.total = 0;
        const gallery = document.getElementById('mediaGallery');
        if (gallery) {
            gallery.querySelectorAll('.gallery-item, .gallery-doc, .gallery-empty').forEach(el => el.remove());
            fetchMoreMedia(gallery);
        }
    }

    // Show metadata modal for each file, then upload
    async function uploadMediaFiles(files, personId) {
        for (const file of files) {
            await showUploadMetadataModal(file, personId);
        }
        loadMediaGallery(personId);
        refreshTree();
    }

    function showUploadMetadataModal(file, personId) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('modalOverlay');
            const content = document.getElementById('modalContent');
            const isImage = file.type.startsWith('image/');
            const previewHtml = isImage
                ? `<img class="upload-preview" id="uploadPreview" alt="Preview">`
                : `<div class="upload-preview" style="display:flex;align-items:center;justify-content:center;height:120px;font-size:14px;color:var(--text-secondary)">${escapeHtml(file.name)}</div>`;

            content.innerHTML = `
                <div class="modal-title">Upload File</div>
                ${previewHtml}
                <form id="uploadMetaForm">
                    <div class="form-group"><label>Title</label><input name="title" placeholder="Optional title..."></div>
                    <div class="form-group"><label>Description</label><textarea name="description" placeholder="Optional description..." rows="2"></textarea></div>
                    <div class="form-row">
                        <div class="form-group"><label>Date</label><input name="media_date" id="uploadDate" type="date"></div>
                        <div class="form-group"><label>Location</label><input name="location" id="uploadLocation" placeholder="e.g. London, UK"></div>
                    </div>
                    <div class="form-group">
                        <label>Tag People</label>
                        <input type="text" id="uploadTagSearch" placeholder="Search by name to tag..." autocomplete="off">
                        <div id="uploadTagResults" style="margin-top:4px"></div>
                        <div id="uploadTaggedList" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px"></div>
                    </div>
                    ${isImage ? `<label class="upload-checkbox"><input type="checkbox" name="set_profile" id="setProfileCheck"> Set as profile photo</label>` : ''}
                    <div class="form-actions">
                        <button type="button" class="btn btn-secondary" id="uploadCancelBtn">Cancel</button>
                        <button type="button" class="btn btn-secondary" id="uploadSkipBtn">Skip Details</button>
                        <button type="submit" class="btn btn-primary">Upload</button>
                    </div>
                </form>`;
            overlay.classList.remove('hidden');

            // Show preview
            if (isImage) {
                const reader = new FileReader();
                reader.onload = (e) => { document.getElementById('uploadPreview').src = e.target.result; };
                reader.readAsDataURL(file);

                // Try EXIF metadata for JPEG (date + GPS)
                const bufReader = new FileReader();
                bufReader.onload = async (e) => {
                    const meta = extractExifMetadata(new Uint8Array(e.target.result));
                    if (meta.date) {
                        const dateInput = document.getElementById('uploadDate');
                        if (dateInput && !dateInput.value) dateInput.value = meta.date;
                    }
                    if (meta.lat !== undefined && meta.lon !== undefined) {
                        const locInput = document.getElementById('uploadLocation');
                        if (locInput && !locInput.value) {
                            locInput.placeholder = 'Looking up location...';
                            const place = await reverseGeocode(meta.lat, meta.lon);
                            if (place && locInput && !locInput.value) {
                                locInput.value = place;
                                locInput.placeholder = 'e.g. London, UK';
                            } else {
                                locInput.placeholder = 'e.g. London, UK';
                            }
                        }
                    }
                };
                bufReader.readAsArrayBuffer(file);
            }

            // Fallback: use file's lastModified date (works for all file types)
            if (file.lastModified) {
                const dateInput = document.getElementById('uploadDate');
                if (dateInput && !dateInput.value) {
                    const d = new Date(file.lastModified);
                    const iso = d.toISOString().split('T')[0]; // YYYY-MM-DD
                    dateInput.value = iso;
                }
            }

            // Tag people search
            const taggedPersonIds = new Set([String(personId)]);
            let tagTimeout;
            const tagSearch = document.getElementById('uploadTagSearch');
            const tagResults = document.getElementById('uploadTagResults');
            const taggedList = document.getElementById('uploadTaggedList');

            function renderTaggedList() {
                taggedList.innerHTML = '';
                taggedPersonIds.forEach(pid => {
                    if (pid === String(personId)) return; // Don't show the auto-tagged person
                    const name = lookupPersonName(pid);
                    const chip = document.createElement('span');
                    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:3px 8px 3px 10px;font-size:12px';
                    chip.innerHTML = `${escapeHtml(name)} <span style="cursor:pointer;font-size:14px;color:var(--text-secondary)" data-remove="${pid}">&times;</span>`;
                    chip.querySelector('[data-remove]').onclick = () => {
                        taggedPersonIds.delete(pid);
                        renderTaggedList();
                    };
                    taggedList.appendChild(chip);
                });
            }

            tagSearch.addEventListener('input', () => {
                clearTimeout(tagTimeout);
                const q = tagSearch.value.trim();
                if (q.length < 2) { tagResults.innerHTML = ''; return; }
                tagTimeout = setTimeout(async () => {
                    const resp = await fetch(`/api/persons?q=${encodeURIComponent(q)}`);
                    const persons = await resp.json();
                    tagResults.innerHTML = '';
                    persons.filter(p => !taggedPersonIds.has(String(p.id))).slice(0, 6).forEach(p => {
                        const item = document.createElement('div');
                        item.className = 'search-result-item';
                        item.textContent = `${p.first_name} ${p.last_name || ''}`.trim();
                        item.onclick = () => {
                            taggedPersonIds.add(String(p.id));
                            tagSearch.value = '';
                            tagResults.innerHTML = '';
                            renderTaggedList();
                        };
                        tagResults.appendChild(item);
                    });
                }, 300);
            });

            async function doUpload(formEl) {
                const fd = new FormData();
                fd.append('file', file);
                taggedPersonIds.forEach(pid => fd.append('person_ids[]', pid));
                if (formEl) {
                    const meta = new FormData(formEl);
                    for (const [k, v] of meta.entries()) {
                        if (k !== 'set_profile' && v) fd.append(k, v);
                    }
                }
                const resp = await fetch('/api/media', { method: 'POST', body: fd });
                const media = await resp.json();
                // Set as profile photo if checked
                if (formEl && formEl.querySelector('#setProfileCheck')?.checked) {
                    await fetch(`/api/media/${media.id}/set-profile/${personId}`, { method: 'PUT' });
                }
                closeModal();
                resolve();
            }

            document.getElementById('uploadMetaForm').onsubmit = (e) => {
                e.preventDefault();
                doUpload(e.target);
            };
            document.getElementById('uploadSkipBtn').onclick = () => doUpload(null);
            document.getElementById('uploadCancelBtn').onclick = () => {
                closeModal();
                resolve();
            };
        });
    }

    // Extract EXIF metadata from JPEG: date + GPS location
    // Returns { date: 'YYYY-MM-DD', lat: number, lon: number } or partial/null
    function extractExifMetadata(bytes) {
        try {
            if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return {};
            let offset = 2;
            while (offset < bytes.length - 1) {
                if (bytes[offset] !== 0xFF) break;
                const marker = bytes[offset + 1];
                if (marker === 0xE1) {
                    const len = (bytes[offset + 2] << 8) | bytes[offset + 3];
                    const exifData = bytes.slice(offset + 4, offset + 2 + len);
                    return parseExifData(exifData);
                }
                if (marker === 0xDA) break;
                const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
                offset += 2 + segLen;
            }
        } catch (e) {}
        return {};
    }

    function parseExifData(data) {
        const result = {};
        try {
            const header = String.fromCharCode(...data.slice(0, 4));
            if (header !== 'Exif') return result;
            const T = 6; // tiff offset
            const le = data[T] === 0x49;
            const r16 = (o) => le ? data[T+o] | (data[T+o+1]<<8) : (data[T+o]<<8) | data[T+o+1];
            const r32 = (o) => le
                ? data[T+o] | (data[T+o+1]<<8) | (data[T+o+2]<<16) | (data[T+o+3]<<24)
                : (data[T+o]<<24) | (data[T+o+1]<<16) | (data[T+o+2]<<8) | data[T+o+3];
            const rStr = (o, n) => String.fromCharCode(...data.slice(T+o, T+o+n)).replace(/\0/g, '').trim();
            // Read EXIF rational (2x uint32: numerator/denominator)
            const rRat = (o) => { const num = r32(o), den = r32(o+4); return den ? num/den : 0; };

            function parseGPS(ifdOff) {
                const cnt = r16(ifdOff);
                let latRef='N', lonRef='E', lat=null, lon=null;
                for (let i = 0; i < cnt; i++) {
                    const e = ifdOff + 2 + i*12;
                    const tag = r16(e);
                    const valOff = r32(e+8);
                    if (tag === 0x0001) latRef = rStr(valOff || (e+8), 1) || 'N'; // GPSLatitudeRef
                    if (tag === 0x0003) lonRef = rStr(valOff || (e+8), 1) || 'E'; // GPSLongitudeRef
                    if (tag === 0x0002) { // GPSLatitude (3 rationals)
                        lat = rRat(valOff) + rRat(valOff+8)/60 + rRat(valOff+16)/3600;
                    }
                    if (tag === 0x0004) { // GPSLongitude (3 rationals)
                        lon = rRat(valOff) + rRat(valOff+8)/60 + rRat(valOff+16)/3600;
                    }
                }
                if (lat !== null && lon !== null) {
                    if (latRef === 'S') lat = -lat;
                    if (lonRef === 'W') lon = -lon;
                    return { lat, lon };
                }
                return null;
            }

            function searchIFD(ifdOff) {
                const cnt = r16(ifdOff);
                for (let i = 0; i < cnt; i++) {
                    const e = ifdOff + 2 + i*12;
                    const tag = r16(e);
                    if ((tag === 0x9003 || tag === 0x0132 || tag === 0x9004) && !result.date) {
                        const valOff = r32(e+8);
                        const ds = rStr(valOff, 19);
                        if (ds && ds.length >= 10) result.date = ds.substring(0,10).replace(/:/g,'-');
                    }
                    if (tag === 0x8769) searchIFD(r32(e+8)); // ExifIFD
                    if (tag === 0x8825) { // GPSIFD
                        const gps = parseGPS(r32(e+8));
                        if (gps) { result.lat = gps.lat; result.lon = gps.lon; }
                    }
                }
            }
            searchIFD(r32(4));
        } catch (e) {}
        return result;
    }

    // Reverse geocode GPS coordinates to a place name (using free Nominatim API)
    async function reverseGeocode(lat, lon) {
        try {
            const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`);
            if (!resp.ok) return null;
            const data = await resp.json();
            const addr = data.address || {};
            // Build a short location string
            const parts = [addr.city || addr.town || addr.village || addr.county, addr.state, addr.country].filter(Boolean);
            return parts.join(', ') || data.display_name || null;
        } catch (e) { return null; }
    }

    async function uploadEvidenceFiles(files, unionId, pcId) {
        for (const file of files) {
            const form = new FormData();
            form.append('file', file);
            const resp = await fetch('/api/media', { method: 'POST', body: form });
            const media = await resp.json();
            const body = { media_id: media.id };
            if (unionId) body.union_id = unionId;
            if (pcId) body.parent_child_id = pcId;
            await fetch('/api/evidence', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
        }
        // Refresh panel
        if (unionId) openUnionPanel(unionId);
    }

    // ── Lightbox + Face Tagging ──────────────────────────────
    function openLightbox(media) {
        const lb = document.getElementById('lightbox');
        const img = document.getElementById('lightboxImg');
        const info = document.getElementById('lightboxInfo');
        img.src = media.file_url;

        // Build post-style metadata below image
        let postHtml = '<div class="lightbox-post">';
        if (media.title) {
            postHtml += `<div class="lightbox-post-title">${escapeHtml(media.title)}</div>`;
        }
        if (media.description) {
            postHtml += `<div class="lightbox-post-desc">${escapeHtml(media.description)}</div>`;
        }
        // Date + location line
        const displayDate = media.media_date || media.uploaded_at;
        const dateLoc = [displayDate, media.location].filter(Boolean);
        if (dateLoc.length > 0) {
            postHtml += `<div class="lightbox-post-date">${dateLoc.map(s => escapeHtml(s)).join(' &middot; ')}</div>`;
        }
        // If no title/desc, show filename as fallback
        if (!media.title && !media.description && media.original_filename) {
            postHtml += `<div class="lightbox-post-filename">${escapeHtml(media.original_filename)}</div>`;
        }
        // Tagged people
        if (media.person_ids && media.person_ids.length > 0) {
            const names = media.person_ids.map(pid => lookupPersonName(pid)).filter(n => n && !n.startsWith('Person #'));
            if (names.length > 0) {
                postHtml += `<div class="lightbox-post-tags">${names.map(n => `<span class="lightbox-tag">${escapeHtml(n)}</span>`).join('')}</div>`;
            }
        }
        postHtml += '</div>';
        info.innerHTML = postHtml;

        lb.classList.remove('hidden');
        loadFaceBoxes(media.id);
    }

    function closeLightbox() {
        document.getElementById('lightbox').classList.add('hidden');
        document.getElementById('faceBoxes').innerHTML = '';
    }

    async function loadFaceBoxes(mediaId) {
        const container = document.getElementById('faceBoxes');
        container.innerHTML = '';
        try {
            const resp = await fetch(`/api/media/${mediaId}/faces`);
            if (!resp.ok) return;
            const faces = await resp.json();
            if (faces.length === 0) {
                const statusResp = await fetch(`/api/media/${mediaId}/face-status`);
                if (statusResp.ok) {
                    const status = await statusResp.json();
                    if (status.status === 'pending' || status.status === 'processing') {
                        container.innerHTML = '<div style="position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.6);color:#fff;padding:4px 10px;border-radius:8px;font-size:12px;">Detecting faces...</div>';
                        setTimeout(() => loadFaceBoxes(mediaId), 3000);
                        return;
                    }
                }
            }
            for (const face of faces) {
                const box = document.createElement('div');
                box.className = 'face-box';
                if (face.person_id) box.classList.add('confirmed');
                else if (face.suggested_person_id) box.classList.add('has-suggestion');
                if (face.is_manual) box.classList.add('manual');

                box.style.left = (face.box_x * 100) + '%';
                box.style.top = (face.box_y * 100) + '%';
                box.style.width = (face.box_w * 100) + '%';
                box.style.height = (face.box_h * 100) + '%';

                // Label
                const label = document.createElement('div');
                label.className = 'face-label';
                if (face.person_name) {
                    label.textContent = face.person_name;
                } else if (face.suggested_person_name) {
                    label.textContent = face.suggested_person_name + '?';
                } else {
                    label.textContent = 'Click to tag';
                }
                box.appendChild(label);

                box.onclick = (e) => {
                    e.stopPropagation();
                    showFacePopover(box, face, mediaId);
                };
                container.appendChild(box);
            }
        } catch (e) { /* face detection may not be available */ }
    }

    function showFacePopover(boxEl, face, mediaId) {
        // Remove any existing popover
        document.querySelectorAll('.face-popover').forEach(p => p.remove());

        const popover = document.createElement('div');
        popover.className = 'face-popover';

        const cancelBtn = `<button class="btn btn-text btn-sm" style="margin-top:4px;width:100%;justify-content:center" id="faceCancelBtn">Cancel</button>`;

        if (face.person_id) {
            popover.innerHTML = `<div class="suggestion-text">Tagged: ${face.person_name}</div>
                <button class="btn btn-danger btn-sm" style="margin-top:8px" id="faceUntag">Remove tag</button>${cancelBtn}`;
            popover.querySelector('#faceUntag').onclick = async () => {
                await fetch(`/api/media/${mediaId}/faces/${face.id}`, { method: 'DELETE' });
                popover.remove();
                loadFaceBoxes(mediaId);
            };
        } else if (face.suggested_person_id) {
            popover.innerHTML = `<div class="suggestion-text">Is this ${face.suggested_person_name}?</div>
                <div style="display:flex;gap:6px;margin-bottom:8px">
                    <button class="btn btn-success btn-sm" id="faceConfirm">Yes</button>
                    <button class="btn btn-secondary btn-sm" id="faceReject">No</button>
                </div>
                <input type="text" placeholder="Or search for someone..." id="faceSearch">${cancelBtn}`;
            popover.querySelector('#faceConfirm').onclick = async () => {
                await fetch(`/api/media/${mediaId}/faces/${face.id}/confirm`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ person_id: face.suggested_person_id }),
                });
                popover.remove();
                loadFaceBoxes(mediaId);
            };
            popover.querySelector('#faceReject').onclick = async () => {
                await fetch(`/api/media/${mediaId}/faces/${face.id}/reject`, { method: 'POST' });
                popover.remove();
                loadFaceBoxes(mediaId);
            };
            setupFaceSearchInput(popover.querySelector('#faceSearch'), mediaId, face.id);
        } else {
            popover.innerHTML = `<div class="suggestion-text">Who is this?</div>
                <input type="text" placeholder="Search by name..." id="faceSearch">${cancelBtn}`;
            setupFaceSearchInput(popover.querySelector('#faceSearch'), mediaId, face.id);
        }

        // Cancel button closes the popover
        const cancelEl = popover.querySelector('#faceCancelBtn');
        if (cancelEl) cancelEl.onclick = () => popover.remove();

        boxEl.appendChild(popover);
        popover.onclick = (e) => e.stopPropagation();
    }

    function setupFaceSearchInput(input, mediaId, faceId) {
        let timeout;
        input.addEventListener('input', () => {
            clearTimeout(timeout);
            timeout = setTimeout(async () => {
                const q = input.value.trim();
                if (q.length < 2) return;
                const resp = await fetch(`/api/persons?q=${encodeURIComponent(q)}`);
                const results = await resp.json();
                // Show inline results
                let dropdown = input.nextElementSibling;
                if (!dropdown || !dropdown.classList.contains('face-search-results')) {
                    dropdown = document.createElement('div');
                    dropdown.className = 'face-search-results';
                    dropdown.style.cssText = 'max-height:150px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin-top:4px';
                    input.after(dropdown);
                }
                dropdown.innerHTML = '';
                for (const p of results.slice(0, 8)) {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';
                    item.textContent = `${p.first_name} ${p.last_name || ''}`.trim();
                    item.onclick = async () => {
                        await fetch(`/api/media/${mediaId}/faces/${faceId}/confirm`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ person_id: p.id }),
                        });
                        document.querySelectorAll('.face-popover').forEach(po => po.remove());
                        loadFaceBoxes(mediaId);
                    };
                    dropdown.appendChild(item);
                }
            }, 300);
        });
    }

    // Manual face tag on lightbox image click
    document.addEventListener('click', (e) => {
        if (e.target.id === 'lightboxImg') {
            const rect = e.target.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;
            showManualTagPopover(x, y, e.target);
        }
    });

    function showManualTagPopover(x, y, imgEl) {
        const wrapper = imgEl.parentElement;
        document.querySelectorAll('.face-popover').forEach(p => p.remove());
        const popover = document.createElement('div');
        popover.className = 'face-popover';
        popover.style.position = 'absolute';
        popover.style.left = (x * 100) + '%';
        popover.style.top = (y * 100 + 3) + '%';
        popover.innerHTML = `<div class="suggestion-text">Who is this?</div><input type="text" placeholder="Search by name..." id="manualFaceSearch">`;
        wrapper.appendChild(popover);

        const input = popover.querySelector('#manualFaceSearch');
        input.focus();
        let timeout;
        input.addEventListener('input', () => {
            clearTimeout(timeout);
            timeout = setTimeout(async () => {
                const q = input.value.trim();
                if (q.length < 2) return;
                const resp = await fetch(`/api/persons?q=${encodeURIComponent(q)}`);
                const results = await resp.json();
                let dropdown = input.nextElementSibling;
                if (!dropdown || !dropdown.classList.contains('face-search-results')) {
                    dropdown = document.createElement('div');
                    dropdown.className = 'face-search-results';
                    dropdown.style.cssText = 'max-height:150px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin-top:4px';
                    input.after(dropdown);
                }
                dropdown.innerHTML = '';
                for (const p of results.slice(0, 8)) {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';
                    item.textContent = `${p.first_name} ${p.last_name || ''}`.trim();
                    item.onclick = async () => {
                        // Get media id from lightbox
                        const imgSrc = document.getElementById('lightboxImg').src;
                        const mediaIdMatch = imgSrc.match(/\/api\/media\/(\d+)\//);
                        if (mediaIdMatch) {
                            await fetch(`/api/media/${mediaIdMatch[1]}/faces/manual`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ person_id: p.id, x, y }),
                            });
                            popover.remove();
                            loadFaceBoxes(parseInt(mediaIdMatch[1]));
                        }
                    };
                    dropdown.appendChild(item);
                }
            }, 300);
        });
        popover.onclick = (e) => e.stopPropagation();
    }

    // ── Notifications ────────────────────────────────────────
    async function loadNotifications() {
        try {
            const resp = await fetch('/api/notifications');
            const data = await resp.json();
            const badge = document.getElementById('notifBadge');
            if (data.unread_count > 0) {
                badge.textContent = data.unread_count;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        } catch (e) { }
    }

    async function showNotifications() {
        const dropdown = document.getElementById('notifDropdown');
        if (!dropdown.classList.contains('hidden')) {
            dropdown.classList.add('hidden');
            return;
        }
        const resp = await fetch('/api/friend-requests');
        const requests = await resp.json();
        dropdown.innerHTML = '';
        if (requests.length === 0) {
            dropdown.innerHTML = '<div class="notif-empty">No pending requests</div>';
        } else {
            for (const req of requests) {
                const item = document.createElement('div');
                item.className = 'notif-item';
                item.innerHTML = `
                    <div class="notif-from">${escapeHtml(req.from_name)}</div>
                    <div class="notif-message">"${escapeHtml(req.message)}"</div>
                    <div class="notif-actions">
                        <button class="btn btn-success btn-sm" data-action="accept" data-id="${req.id}">Accept</button>
                        <button class="btn btn-secondary btn-sm" data-action="reject" data-id="${req.id}">Reject</button>
                    </div>`;
                item.addEventListener('click', async (e) => {
                    const btn = e.target.closest('[data-action]');
                    if (!btn) return;
                    const action = btn.dataset.action;
                    const id = btn.dataset.id;
                    await fetch(`/api/friend-requests/${id}/${action}`, { method: 'POST' });
                    showNotifications();
                    loadNotifications();
                    // Refresh user data to update friend list
                    await loadCurrentUser();
                });
                dropdown.appendChild(item);
            }
        }
        dropdown.classList.remove('hidden');
    }

    // ── Search ───────────────────────────────────────────────
    function setupSearch() {
        const input = document.getElementById('searchInput');
        const results = document.getElementById('searchResults');
        let timeout;

        input.addEventListener('input', () => {
            clearTimeout(timeout);
            const q = input.value.trim();
            if (q.length < 2) {
                results.classList.remove('active');
                return;
            }
            timeout = setTimeout(async () => {
                const resp = await fetch(`/api/persons?q=${encodeURIComponent(q)}`);
                const persons = await resp.json();
                results.innerHTML = '';
                if (persons.length === 0) {
                    results.innerHTML = '<div class="search-result-item">No results</div>';
                } else {
                    for (const p of persons.slice(0, 10)) {
                        const item = document.createElement('div');
                        item.className = 'search-result-item';
                        const name = `${p.first_name} ${p.last_name || ''}`.trim();
                        const detail = [p.occupation, p.current_city, p.current_country].filter(Boolean).join(', ');
                        item.innerHTML = `<div>${escapeHtml(name)}</div>${detail ? `<div class="search-result-match">${escapeHtml(detail)}</div>` : ''}`;
                        item.onclick = () => {
                            input.value = '';
                            results.classList.remove('active');
                            history.pushState({ slug: p.slug }, '', `/person/${p.slug}`);
                            navigateToPersonId(p.id);
                        };
                        results.appendChild(item);
                    }
                }
                results.classList.add('active');
            }, 300);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                results.classList.remove('active');
                input.blur();
            }
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-container')) {
                results.classList.remove('active');
            }
        });
    }

    // ── Add Person Modal ─────────────────────────────────────
    function showAddPersonModal(defaults = {}) {
        const overlay = document.getElementById('modalOverlay');
        const content = document.getElementById('modalContent');
        content.innerHTML = `
            <div class="modal-title">Add Person</div>
            <form id="addPersonForm">
                <div class="form-row">
                    <div class="form-group"><label>First Name *</label><input name="first_name" required value="${defaults.first_name || ''}"></div>
                    <div class="form-group"><label>Last Name</label><input name="last_name" value="${defaults.last_name || ''}"></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>Nickname</label><input name="nickname"></div>
                    <div class="form-group"><label>Gender</label><select name="gender"><option value="">-</option><option value="M">Male</option><option value="F">Female</option><option value="O">Other</option></select></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>Date of Birth</label><input name="date_of_birth" type="date"></div>
                    <div class="form-group"><label>Date of Death</label><input name="date_of_death" type="date"></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>Birth City</label><input name="birth_city"></div>
                    <div class="form-group"><label>Birth Country</label><input name="birth_country"></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>Current City</label><input name="current_city"></div>
                    <div class="form-group"><label>Current Country</label><input name="current_country"></div>
                </div>
                <div class="form-group"><label>Occupation</label><input name="occupation"></div>
                <div class="form-group"><label>Biography</label><textarea name="biography"></textarea></div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="window._closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary">Add Person</button>
                </div>
            </form>`;
        overlay.classList.remove('hidden');

        document.getElementById('addPersonForm').onsubmit = async (e) => {
            e.preventDefault();
            const form = e.target;
            const data = {};
            new FormData(form).forEach((v, k) => { data[k] = v; });
            const resp = await fetch('/api/persons', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (resp.ok) {
                const person = await resp.json();
                closeModal();
                await refreshTree();
                navigateToPersonId(person.id);
            }
        };
    }

    // ── Add Relative Modal ───────────────────────────────────
    function showAddRelativeModal(personId) {
        const overlay = document.getElementById('modalOverlay');
        const content = document.getElementById('modalContent');
        const person = allPersons.find(p => p.id === String(personId));
        const personName = person ? `${person['first name']} ${person['last name'] || ''}`.trim() : `Person #${personId}`;

        content.innerHTML = `
            <div class="modal-title">Add Relative for ${escapeHtml(personName)}</div>
            <div class="form-group">
                <label>Relationship Type</label>
                <select id="relType">
                    <option value="child">Add a Child</option>
                    <option value="parent">Add a Parent</option>
                    <option value="spouse">Add a Spouse</option>
                </select>
            </div>
            <div class="form-group">
                <label>Link to existing person or create new?</label>
                <select id="relMode">
                    <option value="new">Create new person</option>
                    <option value="existing">Link existing person</option>
                </select>
            </div>
            <div id="relExistingSearch" class="form-group hidden">
                <label>Search person</label>
                <input type="text" id="relSearchInput" placeholder="Search by name...">
                <div id="relSearchResults"></div>
                <input type="hidden" id="relSelectedId">
            </div>
            <div id="relNewFields">
                <div class="form-row">
                    <div class="form-group"><label>First Name *</label><input id="relFirstName" required></div>
                    <div class="form-group"><label>Last Name</label><input id="relLastName"></div>
                </div>
                <div class="form-group"><label>Gender</label><select id="relGender"><option value="">-</option><option value="M">Male</option><option value="F">Female</option><option value="O">Other</option></select></div>
            </div>
            <div id="relUnionFields" class="hidden">
                <div class="form-group"><label>Marriage Date</label><input type="date" id="relMarriageDate"></div>
            </div>
            <div class="form-actions">
                <button class="btn btn-secondary" onclick="window._closeModal()">Cancel</button>
                <button class="btn btn-primary" id="relSubmit">Add</button>
            </div>`;
        overlay.classList.remove('hidden');

        const relType = document.getElementById('relType');
        const relMode = document.getElementById('relMode');
        const unionFields = document.getElementById('relUnionFields');
        const existingSearch = document.getElementById('relExistingSearch');
        const newFields = document.getElementById('relNewFields');

        relType.onchange = () => {
            unionFields.classList.toggle('hidden', relType.value !== 'spouse');
        };
        relMode.onchange = () => {
            existingSearch.classList.toggle('hidden', relMode.value !== 'existing');
            newFields.classList.toggle('hidden', relMode.value !== 'new');
        };

        // Search for existing person
        let searchTimeout;
        document.getElementById('relSearchInput').addEventListener('input', function () {
            clearTimeout(searchTimeout);
            const q = this.value.trim();
            const results = document.getElementById('relSearchResults');
            if (q.length < 2) { results.innerHTML = ''; return; }
            searchTimeout = setTimeout(async () => {
                const resp = await fetch(`/api/persons?q=${encodeURIComponent(q)}`);
                const persons = await resp.json();
                results.innerHTML = '';
                for (const p of persons.slice(0, 8)) {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';
                    item.textContent = `${p.first_name} ${p.last_name || ''}`.trim();
                    item.onclick = () => {
                        document.getElementById('relSelectedId').value = p.id;
                        document.getElementById('relSearchInput').value = item.textContent;
                        results.innerHTML = '';
                    };
                    results.appendChild(item);
                }
            }, 300);
        });

        document.getElementById('relSubmit').onclick = async () => {
            let targetId;
            if (relMode.value === 'existing') {
                targetId = document.getElementById('relSelectedId').value;
                if (!targetId) { alert('Select a person'); return; }
            } else {
                const firstName = document.getElementById('relFirstName').value.trim();
                if (!firstName) { alert('First name is required'); return; }
                const resp = await fetch('/api/persons', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        first_name: firstName,
                        last_name: document.getElementById('relLastName').value.trim(),
                        gender: document.getElementById('relGender').value,
                    }),
                });
                const newPerson = await resp.json();
                targetId = newPerson.id;
            }

            const type = relType.value;
            if (type === 'child') {
                await fetch('/api/parent-child', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ parent_id: personId, child_id: targetId }),
                });
            } else if (type === 'parent') {
                await fetch('/api/parent-child', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ parent_id: targetId, child_id: personId }),
                });
            } else if (type === 'spouse') {
                const body = { partner1_id: personId, partner2_id: targetId };
                const marriageDate = document.getElementById('relMarriageDate').value;
                if (marriageDate) body.marriage_date = marriageDate;
                await fetch('/api/unions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
            }

            closeModal();
            await refreshTree();
            navigateToPersonId(personId);
        };
    }

    // ── Edit Person Modal ────────────────────────────────────
    async function showEditPersonModal(personId) {
        const resp = await fetch(`/api/persons/${personId}`);
        const p = await resp.json();
        const overlay = document.getElementById('modalOverlay');
        const content = document.getElementById('modalContent');
        content.innerHTML = `
            <div class="modal-title">Edit Person</div>
            <form id="editPersonForm">
                <div class="form-row">
                    <div class="form-group"><label>First Name *</label><input name="first_name" required value="${escapeHtml(p.first_name || '')}"></div>
                    <div class="form-group"><label>Last Name</label><input name="last_name" value="${escapeHtml(p.last_name || '')}"></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>Nickname</label><input name="nickname" value="${escapeHtml(p.nickname || '')}"></div>
                    <div class="form-group"><label>Gender</label><select name="gender"><option value="">-</option><option value="M" ${p.gender === 'M' ? 'selected' : ''}>Male</option><option value="F" ${p.gender === 'F' ? 'selected' : ''}>Female</option><option value="O" ${p.gender === 'O' ? 'selected' : ''}>Other</option></select></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>Date of Birth</label><input name="date_of_birth" type="date" value="${p.date_of_birth || ''}"></div>
                    <div class="form-group"><label>Date of Death</label><input name="date_of_death" type="date" value="${p.date_of_death || ''}"></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>Birth City</label><input name="birth_city" value="${escapeHtml(p.birth_city || '')}"></div>
                    <div class="form-group"><label>Birth Country</label><input name="birth_country" value="${escapeHtml(p.birth_country || '')}"></div>
                </div>
                <div class="form-row">
                    <div class="form-group"><label>Current City</label><input name="current_city" value="${escapeHtml(p.current_city || '')}"></div>
                    <div class="form-group"><label>Current Country</label><input name="current_country" value="${escapeHtml(p.current_country || '')}"></div>
                </div>
                <div class="form-group"><label>Occupation</label><input name="occupation" value="${escapeHtml(p.occupation || '')}"></div>
                <div class="form-group"><label>Phone Number</label><input name="phone_number" value="${escapeHtml(p.phone_number || '')}"></div>
                <div class="form-group"><label>Biography</label><textarea name="biography">${escapeHtml(p.biography || '')}</textarea></div>
                <div class="form-group"><label>External URLs (one per line or JSON)</label><textarea name="external_urls">${escapeHtml(p.external_urls || '')}</textarea></div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="window._closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary">Save</button>
                </div>
            </form>`;
        overlay.classList.remove('hidden');

        document.getElementById('editPersonForm').onsubmit = async (e) => {
            e.preventDefault();
            const data = {};
            new FormData(e.target).forEach((v, k) => { data[k] = v; });
            await fetch(`/api/persons/${personId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            closeModal();
            await refreshTree();
            openPersonPanel(personId);
        };
    }

    // ── Invite Modal ─────────────────────────────────────────
    function showInviteModal(personId) {
        const overlay = document.getElementById('modalOverlay');
        const content = document.getElementById('modalContent');
        content.innerHTML = `
            <div class="modal-title">Invite Someone</div>
            <p style="margin-bottom:16px;color:var(--text-secondary);font-size:14px">Send an email invite so this person can claim their node and manage their own information.</p>
            <form id="inviteForm">
                <div class="form-group"><label>Email Address *</label><input name="email" type="email" required></div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="window._closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary">Send Invite</button>
                </div>
            </form>`;
        overlay.classList.remove('hidden');

        document.getElementById('inviteForm').onsubmit = async (e) => {
            e.preventDefault();
            const email = new FormData(e.target).get('email');
            const resp = await fetch('/api/invites', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, person_id: personId }),
            });
            if (resp.ok) {
                closeModal();
                alert('Invite sent!');
            } else {
                const err = await resp.json();
                alert(err.error || 'Failed to send invite');
            }
        };
    }

    // ── Friend Request Modal ─────────────────────────────────
    function showFriendRequestModal(toUserId) {
        const overlay = document.getElementById('modalOverlay');
        const content = document.getElementById('modalContent');
        content.innerHTML = `
            <div class="modal-title">Send Friend Request</div>
            <p style="margin-bottom:16px;color:var(--text-secondary);font-size:14px">Include a personal message so they know who you are.</p>
            <form id="friendRequestForm">
                <div class="form-group"><label>Message *</label><textarea name="message" required placeholder="Hi! I'm part of the family..."></textarea></div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="window._closeModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary">Send Request</button>
                </div>
            </form>`;
        overlay.classList.remove('hidden');

        document.getElementById('friendRequestForm').onsubmit = async (e) => {
            e.preventDefault();
            const message = new FormData(e.target).get('message');
            const resp = await fetch('/api/friend-requests', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to_user_id: toUserId, message }),
            });
            if (resp.ok) {
                closeModal();
                alert('Friend request sent!');
            } else {
                const err = await resp.json();
                alert(err.error || 'Failed to send request');
            }
        };
    }

    function closeModal() {
        document.getElementById('modalOverlay').classList.add('hidden');
        document.getElementById('modalContent').innerHTML = '';
    }

    // ── Event Listeners ──────────────────────────────────────
    function setupEventListeners() {
        document.getElementById('btnClosePanel').onclick = closePanel;
        document.getElementById('btnEditMode').onclick = toggleEditMode;
        document.getElementById('btnNotifications').onclick = showNotifications;
        document.getElementById('lightboxClose').onclick = closeLightbox;
        document.querySelector('.lightbox-backdrop').onclick = closeLightbox;
        document.getElementById('modalOverlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeModal();
        });
        setupSearch();

        // Close notif dropdown and dot popover when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.notification-container')) {
                document.getElementById('notifDropdown').classList.add('hidden');
            }
            if (!e.target.closest('.dot-popover') && !e.target.closest('.connector-dot')) {
                hideDotPopover();
            }
        });
    }

    // ── Unfriend ─────────────────────────────────────────────
    function toggleEditMode() {
        const btn = document.getElementById('btnEditMode');
        document.body.classList.toggle('edit-mode');
        btn.classList.toggle('active');
        btn.title = document.body.classList.contains('edit-mode') ? 'Exit edit mode' : 'Toggle edit mode';
    }

    async function unfriend(userId) {
        if (!confirm('Are you sure you want to unfriend this person?')) return;
        await fetch(`/api/friends/${userId}`, { method: 'DELETE' });
        await loadCurrentUser();
        closePanel();
    }

    async function deletePerson(personId, personName) {
        if (!confirm(`Are you sure you want to delete ${personName.trim()}? This will also remove all their relationships, media tags, and evidence links.`)) return;
        const resp = await fetch(`/api/persons/${personId}`, { method: 'DELETE' });
        if (resp.ok) {
            closePanel();
            await refreshTree();
        } else {
            const err = await resp.json().catch(() => ({}));
            alert(err.error || 'Failed to delete person');
        }
    }

    // ── Global bindings (for onclick in HTML) ────────────────
    window._closeModal = closeModal;
    window._editPerson = showEditPersonModal;
    window._invitePerson = showInviteModal;
    window._addRelative = showAddRelativeModal;
    window._openUnionPanel = openUnionPanel;
    window._openProofPanel = openProofPanel;
    window._sendFriendRequest = showFriendRequestModal;
    window._unfriend = unfriend;
    window._deletePerson = deletePerson;
    window._navigateToPerson = (pid) => {
        const person = allPersons.find(p => p.id === String(pid));
        const slug = person ? person.slug : null;
        if (slug) history.pushState({ slug }, '', `/person/${slug}`);
        selectCard(pid);
        openPersonPanel(pid);
    };

    // ── Util ─────────────────────────────────────────────────
    function lookupPersonName(personId) {
        const p = allPersons.find(pp => pp.id === String(personId));
        if (p) return `${p['first name']} ${p['last name'] || ''}`.trim();
        return `Person #${personId}`;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function infoRow(label, value) {
        if (!value) return '';
        return `<div class="info-row"><span class="info-label">${label}</span><span class="info-value">${escapeHtml(value)}</span></div>`;
    }
})();
