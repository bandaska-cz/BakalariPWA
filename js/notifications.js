/* ==========================================================================
   SYSTÉM VYSKAKOVACÍCH UPOZORNĚNÍ S POVINNÝM RUČNÍM POTVRZENÍM
   1) Ráno: Aktuální rozvrh + kroužky + potvrzení připravenosti věcí
   2) 17:00 (pracovní dny): Kontrola domácích úkolů na další den
   3) Večer: Rozvrh a kroužky na následující den + potvrzení přípravy aktovky
   ========================================================================== */

class SchoolNotificationManager {
  constructor(appInstance) {
    this.app = appInstance;
    this.settings = this.loadSettings();
    this.confirmations = this.loadConfirmations();
    this.checkIntervalId = null;
    this.reminderSoundIntervalId = null;
    this.activeAlert = null; // Currently displayed unconfirmed alert
    this.alertQueue = [];
  }

  loadSettings() {
    try {
      const raw = localStorage.getItem(window.BakalariPWA.STORAGE_KEYS.SETTINGS);
      if (raw) {
        return { ...this.getDefaultSettings(), ...JSON.parse(raw) };
      }
    } catch (_) {}
    return this.getDefaultSettings();
  }

  getDefaultSettings() {
    return {
      studentName: 'Eliško',
      morningTime: '07:00',
      homeworkTime: '17:00',
      eveningTime: '19:30',
      soundEnabled: true,
      autoCatchUp: true, // If opened after scheduled time and not yet confirmed today, pop up immediately
      requireChecklistTicks: true // Require ticking checklist items before confirming
    };
  }

  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    localStorage.setItem(window.BakalariPWA.STORAGE_KEYS.SETTINGS, JSON.stringify(this.settings));
  }

  loadConfirmations() {
    try {
      const raw = localStorage.getItem(window.BakalariPWA.STORAGE_KEYS.CONFIRMATIONS);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return {};
  }

  saveConfirmations() {
    localStorage.setItem(window.BakalariPWA.STORAGE_KEYS.CONFIRMATIONS, JSON.stringify(this.confirmations));
  }

  getTodayKey(dateObj = new Date()) {
    return window.BakalariPWA.formatDateIso(dateObj);
  }

  isConfirmed(alertType, dateKey = this.getTodayKey()) {
    return Boolean(this.confirmations[dateKey] && this.confirmations[dateKey][alertType]);
  }

  getConfirmationRecord(alertType, dateKey = this.getTodayKey()) {
    return this.confirmations[dateKey]?.[alertType] || null;
  }

  markConfirmed(alertType, dateKey = this.getTodayKey(), note = '') {
    if (!this.confirmations[dateKey]) {
      this.confirmations[dateKey] = {};
    }
    this.confirmations[dateKey][alertType] = {
      confirmedAt: new Date().toISOString(),
      timeFormatted: new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }),
      note
    };
    this.saveConfirmations();
    this.stopReminderSoundLoop();

    if (this.app && typeof this.app.renderConfirmationStatusBanner === 'function') {
      this.app.renderConfirmationStatusBanner();
    }
  }

  /**
   * Request Web Notification API permission
   */
  async requestPermission() {
    if (!('Notification' in window)) {
      return 'unsupported';
    }
    if (Notification.permission === 'granted') {
      return 'granted';
    }
    const result = await Notification.requestPermission();
    return result;
  }

  /**
   * Start background 20-second scheduler checking morning, 17:00, and evening triggers
   */
  startScheduler() {
    if (this.checkIntervalId) clearInterval(this.checkIntervalId);

    // Initial check shortly after startup
    setTimeout(() => this.evaluateScheduledAlerts(), 1200);

    // Check every 20 seconds
    this.checkIntervalId = setInterval(() => {
      this.evaluateScheduledAlerts();
    }, 20000);

    // Listen for Service Worker messages (when user clicks OS notification)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'OPEN_CONFIRMATION_MODAL') {
          this.triggerAlert(event.data.alertType || 'morning', true);
        }
      });
    }
  }

  /**
   * Parse "HH:MM" into minutes since midnight
   */
  parseMinutes(timeStr) {
    const [h, m] = (timeStr || '07:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  /**
   * Checks current day & time against the 3 mandatory daily notifications:
   * 1. Morning (every workday morning, e.g. 07:00 - 11:30 window)
   * 2. 17:00 Homework check (every workday at 17:00, window 17:00 - 19:29)
   * 3. Evening preparation (every evening before a workday, window 19:30 - 23:00)
   */
  evaluateScheduledAlerts() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sun, 1 = Mon ... 5 = Fri, 6 = Sat
    const isWorkday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isEveningBeforeWorkday = dayOfWeek >= 0 && dayOfWeek <= 4; // Sun - Thu (or Fri if looking at Monday)

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const morningMin = this.parseMinutes(this.settings.morningTime);
    const homeworkMin = this.parseMinutes(this.settings.homeworkTime);
    const eveningMin = this.parseMinutes(this.settings.eveningTime);

    const todayKey = this.getTodayKey(now);

    // 1. Morning Alert Check (Workdays between morningTime and 12:00)
    if (isWorkday && currentMinutes >= morningMin && currentMinutes < 12 * 60) {
      if (!this.isConfirmed('morning', todayKey)) {
        if (this.settings.autoCatchUp || Math.abs(currentMinutes - morningMin) <= 2) {
          this.enqueueAlert('morning', todayKey);
        }
      }
    }

    // 2. 17:00 Homework Alert Check (Workdays between homeworkTime [17:00] and eveningTime)
    if (isWorkday && currentMinutes >= homeworkMin && currentMinutes < eveningMin) {
      if (!this.isConfirmed('homework17', todayKey)) {
        if (this.settings.autoCatchUp || Math.abs(currentMinutes - homeworkMin) <= 2) {
          this.enqueueAlert('homework17', todayKey);
        }
      }
    }

    // 3. Evening Alert Check (Every evening between eveningTime and 23:30)
    if ((isEveningBeforeWorkday || isWorkday) && currentMinutes >= eveningMin && currentMinutes <= 23 * 60 + 30) {
      if (!this.isConfirmed('evening', todayKey)) {
        if (this.settings.autoCatchUp || Math.abs(currentMinutes - eveningMin) <= 2) {
          this.enqueueAlert('evening', todayKey);
        }
      }
    }
  }

  enqueueAlert(alertType, dateKey = this.getTodayKey()) {
    if (this.activeAlert && this.activeAlert.alertType === alertType && this.activeAlert.dateKey === dateKey) {
      return; // Already showing
    }
    if (this.alertQueue.some((a) => a.alertType === alertType && a.dateKey === dateKey)) {
      return; // Already queued
    }

    if (this.activeAlert) {
      this.alertQueue.push({ alertType, dateKey });
    } else {
      this.triggerAlert(alertType, false, dateKey);
    }
  }

  /**
   * Triggers both the persistent OS Web Notification and the Mandatory In-App Confirmation Dialog
   */
  async triggerAlert(alertType, isManualTest = false, dateKey = this.getTodayKey()) {
    const payload = this.buildAlertPayload(alertType, dateKey);
    this.activeAlert = { alertType, dateKey, isManualTest, payload };

    // 1. Play pleasant attention chime & vibrate
    if (this.settings.soundEnabled) {
      this.playAlertChime(alertType);
      this.startReminderSoundLoop(alertType);
    }
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate([250, 100, 250, 100, 400]);
      } catch (_) {}
    }

    // 2. Show Persistent System Web Notification (via Service Worker or Notification API)
    this.dispatchSystemNotification(payload, alertType, dateKey);

    // 3. Open Non-Dismissible In-App Modal (<dialog>)
    this.renderAndOpenModal(payload, alertType, dateKey);
  }

  /**
   * Builds rich context-aware content for each of the 3 alert types:
   * - 'morning': Today's lessons + Today's clubs + Packing/Prep checklist
   * - 'homework17': Homeworks due for the next school day + active homeworks
   * - 'evening': Tomorrow's (next school day's) lessons + Tomorrow's clubs + Packing checklist
   */
  buildAlertPayload(alertType, dateKey) {
    const name = this.settings.studentName || 'Školačko';
    const now = new Date();

    if (alertType === 'morning') {
      const targetDate = now.getDay() === 0 || now.getDay() === 6 ? window.BakalariPWA.getNextSchoolDay(now) : now;
      const daySchedule = this.app.getDayScheduleWithClubs(targetDate);
      const checklist = this.buildPreparationChecklist(daySchedule, 'morning');

      const lessonSummary = daySchedule.lessons.length > 0
        ? daySchedule.lessons.map((l) => `${l.hourCaption}. ${l.subjectAbbrev}`).join(', ')
        : 'Žádné vyučování';

      return {
        badge: '☀️ Ranní kontrola před školou',
        badgeClass: 'badge-morning',
        title: `Dobré ráno, ${name}! Zkontroluj si dnešní rozvrh`,
        subtitle: `${daySchedule.dayLabel} (${daySchedule.dateFormatted}) – příchod do školy včas!`,
        notificationBody: `Dnešní rozvrh: ${lessonSummary}. Klikni pro ruční potvrzení, že máš vše připravené!`,
        daySchedule,
        homeworksList: [],
        checklist,
        confirmButtonText: '✋ Potvrzuji, že mám vše připravené a vyrážím!',
        confirmCheckboxLabel: 'Zkontrolovala jsem si dnešní rozvrh, pomůcky i svačinu a mám vše připravené.'
      };
    }

    if (alertType === 'homework17') {
      const nextSchoolDay = window.BakalariPWA.getNextSchoolDay(now);
      const homeworksInfo = this.app.getHomeworksForAlert(nextSchoolDay);

      const hwCount = homeworksInfo.dueNextDay.length;
      const otherCount = homeworksInfo.otherActive.length;

      let notificationBody = '';
      if (hwCount > 0) {
        notificationBody = `Pozor! Na další školní den máš ${hwCount} ${hwCount === 1 ? 'domácí úkol' : 'domácí úkoly'}. Otevři aplikaci a potvrď kontrolu!`;
      } else if (otherCount > 0) {
        notificationBody = `Na zítřek nemáš žádný nutný úkol, ale máš ${otherCount} ${otherCount === 1 ? 'úkol' : 'úkoly'} na další dny. Potvrď kontrolu!`;
      } else {
        notificationBody = `Skvělá zpráva! Všechny domácí úkoly máš hotové. Potvrď prosím odpolední kontrolu.`;
      }

      const checklist = [];
      if (hwCount > 0) {
        for (const hw of homeworksInfo.dueNextDay) {
          checklist.push({
            id: `chk_hw_${hw.Id}`,
            label: `Úkol z předmětu ${hw.subjectName}: ${hw.Content}`,
            tag: 'Na další den!'
          });
        }
      } else {
        checklist.push({
          id: 'chk_hw_none',
          label: 'Zkontrolovala jsem Bakaláře i sešity – na další den není žádný nesplněný úkol.',
          tag: 'Hotovo'
        });
      }

      for (const hw of homeworksInfo.otherActive.slice(0, 3)) {
        checklist.push({
          id: `chk_hw_other_${hw.Id}`,
          label: `Vím o úkolu na ${hw.dueDateFormatted} (${hw.subjectAbbrev}): ${hw.Content}`,
          tag: `Do ${hw.dueDateFormatted}`
        });
      }

      return {
        badge: '🕔 Kontrola úkolů v 17:00',
        badgeClass: 'badge-homework',
        title: `Odpolední kontrola domácích úkolů (${this.settings.homeworkTime})`,
        subtitle: `Úkoly na následující školní den (${homeworksInfo.nextSchoolDayFormatted})`,
        notificationBody,
        daySchedule: null,
        homeworksInfo,
        checklist,
        confirmButtonText: '✋ Potvrzuji, že jsem zkontrolovala domácí úkoly!',
        confirmCheckboxLabel: 'Potvrzuji, že o všech úkolech na další den vím nebo už je mám vypracované.'
      };
    }

    // Default: 'evening'
    const nextDay = window.BakalariPWA.getNextSchoolDay(now);
    const daySchedule = this.app.getDayScheduleWithClubs(nextDay);
    const checklist = this.buildPreparationChecklist(daySchedule, 'evening');

    const lessonSummary = daySchedule.lessons.length > 0
      ? daySchedule.lessons.map((l) => `${l.hourCaption}. ${l.subjectAbbrev}`).join(', ')
      : 'Žádné vyučování';

    return {
      badge: '🌙 Večerní příprava aktovky',
      badgeClass: 'badge-evening',
      title: `Dobrý večer, ${name}! Připrav si věci na zítřek`,
      subtitle: `Rozvrh na ${daySchedule.dayLabel.toLowerCase()} (${daySchedule.dateFormatted})`,
      notificationBody: `Zítřejší rozvrh: ${lessonSummary}. Připrav si aktovku a ručně potvrď upozornění!`,
      daySchedule,
      homeworksList: [],
      checklist,
      confirmButtonText: '✋ Potvrzuji, že mám aktovku na zítřek sbalenou!',
      confirmCheckboxLabel: 'Mám sbalené všechny učebnice, sešity, penál i věci na kroužky na další den.'
    };
  }

  /**
   * Generates smart checklist items from a day's lessons and clubs
   */
  buildPreparationChecklist(daySchedule, mode = 'morning') {
    const items = [];
    const seenSubjects = new Set();

    for (const lesson of daySchedule.lessons) {
      if (lesson.isCancelled) continue;
      const key = lesson.subjectAbbrev || lesson.subjectName;
      if (seenSubjects.has(key)) continue;
      seenSubjects.add(key);

      let extraHint = 'Učebnice a sešit';
      const abbrevLower = (lesson.subjectAbbrev || '').toLowerCase();
      if (abbrevLower.includes('tv') || abbrevLower.includes('těl')) {
        extraHint = 'Cvičební úbor a sportovní obuv do tělocvičny!';
      } else if (abbrevLower.includes('vv') || abbrevLower.includes('výt')) {
        extraHint = 'Kufřík na výtvarku, tempery, čtvrtky';
      } else if (abbrevLower.includes('m') || abbrevLower.includes('mat')) {
        extraHint = 'Učebnice, sešit, pravítko, úhloměr a kružítko';
      } else if (abbrevLower.includes('aj') || abbrevLower.includes('ang')) {
        extraHint = 'Učebnice, pracovní sešit a slovníček';
      }

      items.push({
        id: `chk_subj_${key}`,
        label: `${lesson.subjectName} (${lesson.subjectAbbrev}) – ${extraHint}`,
        tag: `${lesson.beginTime}`
      });
    }

    for (const club of daySchedule.clubs) {
      items.push({
        id: `chk_club_${club.id}`,
        label: `Kroužek: ${club.name}${club.equipment ? ` – s sebou: ${club.equipment}` : ''}`,
        tag: `${club.beginTime}–${club.endTime}`
      });
    }

    if (mode === 'morning') {
      items.push({
        id: 'chk_essentials_morning',
        label: 'Svačina, pití, čip do jídelny / klíče a vybavený penál',
        tag: 'Nutnosti'
      });
    } else {
      items.push({
        id: 'chk_essentials_evening',
        label: 'Ořezané tužky v penálu, žákovská knížka / čip a připravené oblečení na ráno',
        tag: 'Na ráno'
      });
    }

    return items;
  }

  /**
   * Sends persistent system notification via Service Worker or Notification constructor
   */
  async dispatchSystemNotification(payload, alertType, dateKey) {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    const notifPayload = {
      title: payload.title,
      body: payload.notificationBody,
      tag: `skolni-partak-${alertType}-${dateKey}`,
      alertType,
      dateKey
    };

    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        if (reg && reg.active) {
          reg.active.postMessage({
            type: 'SHOW_PERSISTENT_NOTIFICATION',
            payload: notifPayload
          });
          return;
        }
      }
      // Fallback to direct Notification API
      const notif = new Notification(payload.title, {
        body: payload.notificationBody,
        icon: './icons/icon.svg',
        tag: notifPayload.tag,
        requireInteraction: true
      });
      notif.onclick = () => {
        window.focus();
        notif.close();
      };
    } catch (e) {
      console.warn('Nelze zobrazit systémovou notifikaci:', e);
    }
  }

  /**
   * Renders and opens the non-dismissible <dialog> requiring manual confirmation
   */
  renderAndOpenModal(payload, alertType, dateKey) {
    const dialog = document.getElementById('mandatory-alert-dialog');
    if (!dialog) return;

    const badgeEl = document.getElementById('alert-modal-badge');
    const titleEl = document.getElementById('alert-modal-title');
    const subtitleEl = document.getElementById('alert-modal-subtitle');
    const bodyEl = document.getElementById('alert-modal-body');
    const checklistEl = document.getElementById('alert-modal-checklist');
    const masterCheckEl = document.getElementById('alert-modal-master-check');
    const masterLabelEl = document.getElementById('alert-modal-master-label');
    const confirmBtn = document.getElementById('alert-modal-confirm-btn');

    badgeEl.textContent = payload.badge;
    badgeEl.className = `alert-badge ${payload.badgeClass}`;
    titleEl.textContent = payload.title;
    subtitleEl.textContent = payload.subtitle;
    masterLabelEl.textContent = payload.confirmCheckboxLabel;
    confirmBtn.textContent = payload.confirmButtonText;

    // Render schedule or homework summary inside modal body
    if (alertType === 'homework17' && payload.homeworksInfo) {
      const { dueNextDay, otherActive } = payload.homeworksInfo;
      let html = '';

      if (dueNextDay.length > 0) {
        html += `<div class="modal-section-title">📚 Úkoly na následující školní den (${dueNextDay.length}):</div>`;
        html += `<div class="modal-cards-list">`;
        for (const hw of dueNextDay) {
          html += `
            <div class="modal-hw-card urgent">
              <div class="modal-hw-header">
                <span class="subj-pill">${escapeHtml(hw.subjectAbbrev)}</span>
                <strong>${escapeHtml(hw.subjectName)}</strong>
                <span class="hw-due-tag">Na zítřek!</span>
              </div>
              <p class="modal-hw-text">${escapeHtml(hw.Content)}</p>
            </div>
          `;
        }
        html += `</div>`;
      } else {
        html += `
          <div class="modal-empty-success">
            <span class="success-icon" aria-hidden="true">🎉</span>
            <div>
              <strong>Na zítřek nemáš žádný nehotový úkol!</strong>
              <p>Přesto si níže potvrď, že sis zkontrolovala sešity a případné úkoly na další dny.</p>
            </div>
          </div>
        `;
      }

      if (otherActive.length > 0) {
        html += `<div class="modal-section-title mt-3">🗓️ Další aktivní úkoly v tomto týdnu (${otherActive.length}):</div>`;
        html += `<div class="modal-cards-list">`;
        for (const hw of otherActive) {
          html += `
            <div class="modal-hw-card">
              <div class="modal-hw-header">
                <span class="subj-pill">${escapeHtml(hw.subjectAbbrev)}</span>
                <strong>${escapeHtml(hw.subjectName)}</strong>
                <span class="hw-due-tag secondary">Termín: ${escapeHtml(hw.dueDateFormatted)}</span>
              </div>
              <p class="modal-hw-text">${escapeHtml(hw.Content)}</p>
            </div>
          `;
        }
        html += `</div>`;
      }
      bodyEl.innerHTML = html;
    } else if (payload.daySchedule) {
      const { lessons, clubs } = payload.daySchedule;
      let html = `<div class="modal-section-title">🏫 Rozvrh vyučování (${lessons.length} ${lessons.length === 1 ? 'hodina' : (lessons.length >= 2 && lessons.length <= 4 ? 'hodiny' : 'hodin')}):</div>`;

      if (lessons.length === 0) {
        html += `<p class="empty-note">Žádné školní vyučování v tento den.</p>`;
      } else {
        html += `<div class="modal-timetable-chips">`;
        for (const l of lessons) {
          const changeClass = l.change ? 'has-change' : '';
          const cancelledClass = l.isCancelled ? 'is-cancelled' : '';
          html += `
            <div class="modal-lesson-chip ${changeClass} ${cancelledClass}">
              <span class="chip-hour">${escapeHtml(l.hourCaption)}. hod (${escapeHtml(l.beginTime)})</span>
              <strong class="chip-subj">${escapeHtml(l.subjectName)}</strong>
              <span class="chip-room">Učebna: ${escapeHtml(l.roomAbbrev || '—')}</span>
              ${l.change ? `<span class="chip-change-note">⚠️ ${escapeHtml(l.change.Description || 'Změna v rozvrhu')}</span>` : ''}
            </div>
          `;
        }
        html += `</div>`;
      }

      if (clubs.length > 0) {
        html += `<div class="modal-section-title mt-3">🎨 Odpolední kroužky (${clubs.length}):</div>`;
        html += `<div class="modal-timetable-chips">`;
        for (const c of clubs) {
          html += `
            <div class="modal-lesson-chip club-chip" style="--club-color: ${escapeHtml(c.color || '#8b5cf6')}">
              <span class="chip-hour">${escapeHtml(c.beginTime)} – ${escapeHtml(c.endTime)}</span>
              <strong class="chip-subj">🌟 ${escapeHtml(c.name)}</strong>
              <span class="chip-room">${escapeHtml(c.location || 'Kroužek')}</span>
              ${c.equipment ? `<span class="chip-equip-note">🎒 S sebou: ${escapeHtml(c.equipment)}</span>` : ''}
            </div>
          `;
        }
        html += `</div>`;
      }

      bodyEl.innerHTML = html;
    }

    // Render interactive checklist items
    let chkHtml = '';
    for (const item of payload.checklist) {
      chkHtml += `
        <label class="checklist-row" for="${escapeHtml(item.id)}">
          <input type="checkbox" class="alert-item-checkbox" id="${escapeHtml(item.id)}">
          <span class="checklist-text">${escapeHtml(item.label)}</span>
          <span class="checklist-tag">${escapeHtml(item.tag)}</span>
        </label>
      `;
    }
    checklistEl.innerHTML = chkHtml;

    // Reset checkboxes and update button state
    masterCheckEl.checked = false;
    const itemCheckboxes = Array.from(checklistEl.querySelectorAll('.alert-item-checkbox'));

    const updateConfirmButtonState = () => {
      const allItemsChecked = itemCheckboxes.every((cb) => cb.checked);
      if (this.settings.requireChecklistTicks) {
        confirmBtn.disabled = !(allItemsChecked && masterCheckEl.checked);
      } else {
        confirmBtn.disabled = !masterCheckEl.checked;
      }
    };

    itemCheckboxes.forEach((cb) => {
      cb.addEventListener('change', () => {
        if (itemCheckboxes.every((i) => i.checked) && !masterCheckEl.checked) {
          masterCheckEl.checked = true;
        }
        updateConfirmButtonState();
      });
    });

    masterCheckEl.onchange = () => {
      if (masterCheckEl.checked) {
        itemCheckboxes.forEach((cb) => { cb.checked = true; });
      }
      updateConfirmButtonState();
    };

    updateConfirmButtonState();

    // Prevent closing with Escape key (mandatory manual confirmation!)
    dialog.oncancel = (e) => {
      e.preventDefault();
      this.shakeDialog(dialog);
    };

    confirmBtn.onclick = () => {
      if (confirmBtn.disabled) return;
      this.markConfirmed(alertType, dateKey);
      dialog.close('confirmed');
      this.activeAlert = null;

      // Show next queued alert if any
      if (this.alertQueue.length > 0) {
        const next = this.alertQueue.shift();
        setTimeout(() => this.triggerAlert(next.alertType, false, next.dateKey), 500);
      }
    };

    if (!dialog.open) {
      dialog.showModal();
    }
  }

  shakeDialog(dialog) {
    dialog.classList.remove('shake-warning');
    void dialog.offsetWidth;
    dialog.classList.add('shake-warning');
  }

  /**
   * Plays a friendly musical chime using Web Audio API (zero external audio files needed)
   */
  playAlertChime(alertType = 'morning') {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();

      const notes = alertType === 'homework17'
        ? [523.25, 659.25, 783.99, 1046.5] // C5, E5, G5, C6
        : alertType === 'evening'
          ? [440, 554.37, 659.25, 880]     // A4, C#5, E5, A5
          : [587.33, 739.99, 880, 1174.66]; // D5, F#5, A5, D6

      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.14);

        gain.gain.setValueAtTime(0.001, ctx.currentTime + idx * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + idx * 0.14 + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.14 + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(ctx.currentTime + idx * 0.14);
        osc.stop(ctx.currentTime + idx * 0.14 + 0.36);
      });
    } catch (_) {}
  }

  startReminderSoundLoop(alertType) {
    this.stopReminderSoundLoop();
    // Gentle reminder chime every 45 seconds until the daughter confirms the popup
    this.reminderSoundIntervalId = setInterval(() => {
      if (this.activeAlert && this.settings.soundEnabled) {
        this.playAlertChime(alertType);
      } else {
        this.stopReminderSoundLoop();
      }
    }, 45000);
  }

  stopReminderSoundLoop() {
    if (this.reminderSoundIntervalId) {
      clearInterval(this.reminderSoundIntervalId);
      this.reminderSoundIntervalId = null;
    }
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.SchoolNotificationManager = SchoolNotificationManager;
window.escapeHtml = escapeHtml;

