/* ==========================================================================
   ŠKOLNÍ PARŤÁK (BAKALÁŘI PWA) - MAIN APPLICATION CONTROLLER
   ========================================================================== */

const DAY_NAMES_CS = [
  'Neděle',
  'Pondělí',
  'Úterý',
  'Středa',
  'Čtvrtek',
  'Pátek',
  'Sobota'
];

const DAY_SHORT_CS = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];

class SkolniPartakApp {
  constructor() {
    this.api = new window.BakalariPWA.BakalariApiClient();
    this.notifier = new window.SchoolNotificationManager(this);

    this.schoolData = null;
    this.clubs = window.BakalariPWA.loadCustomClubs();
    this.customHomeworks = this.loadCustomHomeworks();
    this.hwDoneMap = this.loadHwDoneMap();
    this.whatIfMarks = {}; // { [subjectId]: [{ MarkText, Weight, Caption }] }
    this.gradeThresholdOffset = 0.5; // 1.50, 2.50, etc.

    this.activeTab = 'dashboard';
    this.selectedDayOfWeek = this.getInitialSelectedDay(); // 1..5 (Mon..Fri)
    this.timetableViewMode = 'daily'; // 'daily' | 'weekly'
    this.weekOffset = 0; // 0 = current week, 1 = next week
    this.hwFilter = 'active'; // 'active' | 'tomorrow' | 'all'
  }

  getInitialSelectedDay() {
    const d = new Date().getDay();
    if (d >= 1 && d <= 5) return d;
    return 1; // Default to Monday on weekends
  }

  loadCustomHomeworks() {
    try {
      const raw = localStorage.getItem(window.BakalariPWA.STORAGE_KEYS.CUSTOM_HOMEWORKS);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return [];
  }

  saveCustomHomeworks() {
    localStorage.setItem(window.BakalariPWA.STORAGE_KEYS.CUSTOM_HOMEWORKS, JSON.stringify(this.customHomeworks));
  }

  loadHwDoneMap() {
    try {
      const raw = localStorage.getItem(window.BakalariPWA.STORAGE_KEYS.HW_DONE_MAP);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return {};
  }

  saveHwDoneMap() {
    localStorage.setItem(window.BakalariPWA.STORAGE_KEYS.HW_DONE_MAP, JSON.stringify(this.hwDoneMap));
  }

  async init() {
    this.registerServiceWorker();
    this.bindNavigation();
    this.bindGlobalActions();

    await this.refreshData();
    this.notifier.startScheduler();

    // Check URL hash or query param (e.g. ?confirm=morning from notification click)
    const params = new URLSearchParams(window.location.search);
    const confirmParam = params.get('confirm');
    if (confirmParam && ['morning', 'homework17', 'evening'].includes(confirmParam)) {
      setTimeout(() => this.notifier.triggerAlert(confirmParam, true), 400);
    }

    if (window.location.hash) {
      const tabFromHash = window.location.hash.replace('#', '');
      if (['dashboard', 'timetable', 'marks', 'homeworks', 'settings'].includes(tabFromHash)) {
        this.switchTab(tabFromHash);
      }
    }
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Registrace Service Workeru selhala:', err);
      });
    }
  }

  async refreshData() {
    this.setLoadingState(true);
    try {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + this.weekOffset * 7);
      this.schoolData = await this.api.fetchAllSchoolData(targetDate);
      this.renderAll();
    } catch (err) {
      this.showToast(`Chyba načítání dat: ${err.message}`, 'error');
      // Fallback to demo data if nothing is cached
      if (!this.schoolData) {
        this.schoolData = this.api.getDemoSchoolData();
        this.renderAll();
      }
    } finally {
      this.setLoadingState(false);
    }
  }

  setLoadingState(isLoading) {
    const syncBtn = document.getElementById('btn-refresh-data');
    if (syncBtn) {
      syncBtn.classList.toggle('is-spinning', isLoading);
    }
  }

  /* ========================================================================
     DATA NORMALIZATION HELPERS (Timetable + Clubs + Homeworks)
     ======================================================================== */

  /**
   * Builds a unified schedule for a specific Date (or dayOfWeek 1..5),
   * merging Bakaláři timetable lessons with user-added Kroužky
   */
  getDayScheduleWithClubs(targetDateOrDayOfWeek) {
    const tt = this.schoolData?.timetable || { Hours: [], Days: [], Subjects: [], Teachers: [], Rooms: [] };
    let dayOfWeek = 1;
    let dateObj = new Date();

    if (typeof targetDateOrDayOfWeek === 'number') {
      dayOfWeek = targetDateOrDayOfWeek;
      const monday = window.BakalariPWA.getMondayOfWeek(new Date());
      monday.setDate(monday.getDate() + this.weekOffset * 7 + (dayOfWeek - 1));
      dateObj = monday;
    } else if (targetDateOrDayOfWeek instanceof Date) {
      dateObj = new Date(targetDateOrDayOfWeek);
      dayOfWeek = dateObj.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        dateObj = window.BakalariPWA.getNextSchoolDay(dateObj);
        dayOfWeek = dateObj.getDay();
      }
    }

    const hoursMap = new Map((tt.Hours || []).map((h) => [h.Id, h]));
    const subjectsMap = new Map((tt.Subjects || []).map((s) => [String(s.Id).trim(), s]));
    const teachersMap = new Map((tt.Teachers || []).map((t) => [String(t.Id).trim(), t]));
    const roomsMap = new Map((tt.Rooms || []).map((r) => [String(r.Id).trim(), r]));

    const dayEntry = (tt.Days || []).find((d) => Number(d.DayOfWeek) === dayOfWeek) || null;
    const lessons = [];

    if (dayEntry && Array.isArray(dayEntry.Atoms)) {
      for (const atom of dayEntry.Atoms) {
        const hour = hoursMap.get(atom.HourId) || { Id: atom.HourId, Caption: String(atom.HourId), BeginTime: '', EndTime: '' };
        const subj = subjectsMap.get(String(atom.SubjectId || '').trim());
        const teacher = teachersMap.get(String(atom.TeacherId || '').trim());
        const room = roomsMap.get(String(atom.RoomId || '').trim());

        const isCancelled = atom.Change && (atom.Change.ChangeType === 'Canceled' || atom.Change.ChangeType === 'Removed');

        lessons.push({
          hourId: atom.HourId,
          hourCaption: hour.Caption || String(atom.HourId),
          beginTime: hour.BeginTime || '',
          endTime: hour.EndTime || '',
          subjectId: atom.SubjectId,
          subjectAbbrev: subj ? subj.Abbrev : (atom.Change?.TypeAbbrev || 'Změna'),
          subjectName: subj ? subj.Name : (atom.Change?.Description || 'Změna v rozvrhu'),
          teacherAbbrev: teacher ? teacher.Abbrev : '',
          teacherName: teacher ? teacher.Name : '',
          roomAbbrev: room ? room.Abbrev : '',
          roomName: room ? room.Name : '',
          theme: atom.Theme || '',
          change: atom.Change || null,
          isCancelled: Boolean(isCancelled)
        });
      }
    }

    lessons.sort((a, b) => Number(a.hourId) - Number(b.hourId));

    const dayClubs = this.clubs
      .filter((c) => Number(c.dayOfWeek) === dayOfWeek)
      .sort((a, b) => (a.beginTime || '').localeCompare(b.beginTime || ''));

    return {
      dayOfWeek,
      dayLabel: DAY_NAMES_CS[dayOfWeek] || 'Den',
      dateObj,
      dateIso: window.BakalariPWA.formatDateIso(dateObj),
      dateFormatted: dateObj.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' }),
      dayType: dayEntry?.DayType || 'WorkDay',
      dayDescription: dayEntry?.DayDescription || '',
      lessons,
      clubs: dayClubs
    };
  }

  /**
   * Returns merged list of Bakaláři homeworks + custom student homeworks
   */
  getAllNormalizedHomeworks() {
    const rawList = this.schoolData?.homeworks?.Homeworks || [];
    const ttSubjects = this.schoolData?.timetable?.Subjects || [];
    const subjMap = new Map(ttSubjects.map((s) => [String(s.Id).trim(), s]));

    const normalized = rawList.map((hw) => {
      const id = String(hw.Id || hw.ID || `${hw.DateEnd}_${hw.Content?.slice(0, 10)}`);
      const subjObj = hw.Subject || subjMap.get(String(hw.SubjectId || '').trim()) || { Abbrev: 'Škola', Name: 'Školní úkol' };
      const dueStr = hw.DateEnd || hw.Date || hw.DateStart || new Date().toISOString();
      const dueDate = new Date(dueStr);
      const dueIso = window.BakalariPWA.formatDateIso(dueDate);

      const isDone = id in this.hwDoneMap
        ? Boolean(this.hwDoneMap[id])
        : Boolean(hw.Done || hw.Finished || hw.IsCompleted);

      return {
        Id: id,
        Content: hw.Content || hw.Text || '',
        subjectAbbrev: subjObj.Abbrev || 'Úkol',
        subjectName: subjObj.Name || 'Předmět',
        teacherName: hw.Teacher?.Name || '',
        dueDate,
        dueIso,
        dueDateFormatted: dueDate.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' }),
        isDone,
        isCustom: false
      };
    });

    for (const chw of this.customHomeworks) {
      const dueDate = new Date(chw.dueIso + 'T08:00:00');
      const isDone = chw.id in this.hwDoneMap ? Boolean(this.hwDoneMap[chw.id]) : Boolean(chw.isDone);
      normalized.push({
        Id: chw.id,
        Content: chw.content,
        subjectAbbrev: chw.subjectAbbrev || 'Vlastní',
        subjectName: chw.subjectName || 'Vlastní úkol',
        teacherName: 'Vlastní poznámka',
        dueDate,
        dueIso: chw.dueIso,
        dueDateFormatted: dueDate.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' }),
        isDone,
        isCustom: true
      });
    }

    normalized.sort((a, b) => a.dueIso.localeCompare(b.dueIso));
    return normalized;
  }

  /**
   * Used by the 17:00 Homework Notification to get tasks due on the next school day
   */
  getHomeworksForAlert(nextSchoolDay = window.BakalariPWA.getNextSchoolDay()) {
    const nextIso = window.BakalariPWA.formatDateIso(nextSchoolDay);
    const todayIso = window.BakalariPWA.formatDateIso(new Date());
    const all = this.getAllNormalizedHomeworks();

    const dueNextDay = all.filter((hw) => !hw.isDone && (hw.dueIso === nextIso || hw.dueIso === todayIso));
    const otherActive = all.filter((hw) => !hw.isDone && hw.dueIso > nextIso);

    return {
      nextSchoolDayIso: nextIso,
      nextSchoolDayFormatted: nextSchoolDay.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric' }),
      dueNextDay,
      otherActive
    };
  }

  /* ========================================================================
     RENDERING METHODS
     ======================================================================== */

  renderAll() {
    this.renderHeaderStatus();
    this.renderConfirmationStatusBanner();
    this.renderDashboard();
    this.renderTimetableSection();
    this.renderMarksSection();
    this.renderHomeworksSection();
    this.renderSettingsSection();
  }

  renderHeaderStatus() {
    const studentNameEl = document.getElementById('header-student-name');
    const modeBadgeEl = document.getElementById('header-mode-badge');
    const user = this.schoolData?.user || {};

    if (studentNameEl) {
      studentNameEl.textContent = user.FullName || this.notifier.settings.studentName || 'Školačka';
    }
    if (modeBadgeEl) {
      if (this.schoolData?.isDemo) {
        modeBadgeEl.textContent = 'Ukázkový režim (Demo ZŠ)';
        modeBadgeEl.className = 'status-pill demo';
      } else if (this.schoolData?.isOfflineFallback) {
        modeBadgeEl.textContent = 'Offline mezipaměť';
        modeBadgeEl.className = 'status-pill offline';
      } else {
        modeBadgeEl.textContent = 'Bakaláři API v3 aktivní';
        modeBadgeEl.className = 'status-pill live';
      }
    }
  }

  /**
   * Renders the 3 daily confirmation cards (Morning, 17:00 Homework, Evening)
   */
  renderConfirmationStatusBanner() {
    const container = document.getElementById('daily-confirmations-grid');
    if (!container) return;

    const todayKey = this.notifier.getTodayKey();
    const items = [
      {
        type: 'morning',
        icon: '☀️',
        title: 'Ranní příprava a rozvrh',
        time: this.notifier.settings.morningTime,
        desc: 'Kontrola dnešního rozvrhu a pomůcek před odchodem'
      },
      {
        type: 'homework17',
        icon: '🕔',
        title: 'Úkoly na další den (17:00)',
        time: this.notifier.settings.homeworkTime,
        desc: 'Kontrola domácích úkolů každý pracovní den v pět hodin'
      },
      {
        type: 'evening',
        icon: '🌙',
        title: 'Večerní chystání aktovky',
        time: this.notifier.settings.eveningTime,
        desc: 'Kontrola rozvrhu a kroužků na následující den'
      }
    ];

    container.innerHTML = items.map((item) => {
      const record = this.notifier.getConfirmationRecord(item.type, todayKey);
      const isDone = Boolean(record);

      return `
        <article class="confirm-status-card ${isDone ? 'is-confirmed' : 'is-pending'}">
          <div class="confirm-card-top">
            <span class="confirm-card-icon" aria-hidden="true">${item.icon}</span>
            <div class="confirm-card-meta">
              <span class="confirm-time-tag">⏰ ${window.escapeHtml(item.time)}</span>
              <span class="confirm-state-pill ${isDone ? 'done' : 'pending'}">
                ${isDone ? `✅ Potvrzeno v ${window.escapeHtml(record.timeFormatted)}` : '⏳ Čeká na ruční potvrzení'}
              </span>
            </div>
          </div>
          <h3>${window.escapeHtml(item.title)}</h3>
          <p>${window.escapeHtml(item.desc)}</p>
          <button type="button" class="btn-trigger-alert ${isDone ? 'secondary' : 'primary'}" data-trigger-alert="${item.type}">
            ${isDone ? '🔄 Zobrazit znovu / Překontrolovat' : '✋ Otevřít a ručně potvrdit'}
          </button>
        </article>
      `;
    }).join('');

    container.querySelectorAll('[data-trigger-alert]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-trigger-alert');
        this.notifier.triggerAlert(type, true);
      });
    });
  }

  /**
   * Renders the Dashboard overview
   */
  renderDashboard() {
    // 1. Today / Next school day schedule preview
    const now = new Date();
    const isEveningOrWeekend = now.getHours() >= 16 || now.getDay() === 0 || now.getDay() === 6;
    const targetDate = isEveningOrWeekend ? window.BakalariPWA.getNextSchoolDay(now) : now;
    const schedule = this.getDayScheduleWithClubs(targetDate);

    const schedTitleEl = document.getElementById('dash-schedule-title');
    const schedListEl = document.getElementById('dash-schedule-list');

    if (schedTitleEl) {
      schedTitleEl.textContent = `${isEveningOrWeekend ? 'Rozvrh na další školní den' : 'Dnešní rozvrh hodin'} – ${schedule.dayLabel} (${schedule.dateFormatted})`;
    }

    if (schedListEl) {
      let html = '';
      if (schedule.lessons.length === 0) {
        html += `<p class="empty-state-msg">Žádné školní vyučování.</p>`;
      } else {
        for (const l of schedule.lessons) {
          html += `
            <div class="dash-lesson-row ${l.change ? 'has-change' : ''} ${l.isCancelled ? 'is-cancelled' : ''}">
              <div class="lesson-num-badge">${window.escapeHtml(l.hourCaption)}.</div>
              <div class="lesson-time-col">${window.escapeHtml(l.beginTime)}<br><small>${window.escapeHtml(l.endTime)}</small></div>
              <div class="lesson-main-col">
                <strong>${window.escapeHtml(l.subjectName)}</strong>
                ${l.theme ? `<span class="lesson-theme-text">${window.escapeHtml(l.theme)}</span>` : ''}
                ${l.change ? `<span class="lesson-change-badge">⚠️ ${window.escapeHtml(l.change.Description || 'Změna')}</span>` : ''}
              </div>
              <div class="lesson-room-badge">${window.escapeHtml(l.roomAbbrev || '—')}</div>
            </div>
          `;
        }
      }

      if (schedule.clubs.length > 0) {
        html += `<div class="dash-clubs-divider">🌟 Odpolední kroužky (${schedule.clubs.length})</div>`;
        for (const c of schedule.clubs) {
          html += `
            <div class="dash-lesson-row club-row" style="--club-accent: ${window.escapeHtml(c.color || '#8b5cf6')}">
              <div class="lesson-num-badge club">🎨</div>
              <div class="lesson-time-col">${window.escapeHtml(c.beginTime)}<br><small>${window.escapeHtml(c.endTime)}</small></div>
              <div class="lesson-main-col">
                <strong>${window.escapeHtml(c.name)}</strong>
                <span class="lesson-theme-text">📍 ${window.escapeHtml(c.location || 'Kroužek')}${c.equipment ? ` • 🎒 ${window.escapeHtml(c.equipment)}` : ''}</span>
              </div>
            </div>
          `;
        }
      }

      schedListEl.innerHTML = html;
    }

    // 2. Dashboard Homeworks Summary
    const hwContainer = document.getElementById('dash-homeworks-list');
    const allHw = this.getAllNormalizedHomeworks();
    const activeHw = allHw.filter((h) => !h.isDone);
    const badgeCountEl = document.getElementById('nav-hw-badge');
    if (badgeCountEl) {
      badgeCountEl.textContent = String(activeHw.length);
      badgeCountEl.hidden = activeHw.length === 0;
    }

    if (hwContainer) {
      if (activeHw.length === 0) {
        hwContainer.innerHTML = `
          <div class="empty-celebration">
            <span aria-hidden="true">🎉</span>
            <p>Všechny domácí úkoly jsou hotové! Skvělá práce.</p>
          </div>
        `;
      } else {
        hwContainer.innerHTML = activeHw.slice(0, 4).map((hw) => `
          <div class="dash-hw-item">
            <label class="hw-check-wrap">
              <input type="checkbox" data-toggle-hw="${window.escapeHtml(hw.Id)}" ${hw.isDone ? 'checked' : ''}>
              <span class="subj-pill">${window.escapeHtml(hw.subjectAbbrev)}</span>
            </label>
            <div class="dash-hw-content">
              <div class="dash-hw-top">
                <strong>${window.escapeHtml(hw.subjectName)}</strong>
                <span class="due-pill">Do ${window.escapeHtml(hw.dueDateFormatted)}</span>
              </div>
              <p>${window.escapeHtml(hw.Content)}</p>
            </div>
          </div>
        `).join('');

        hwContainer.querySelectorAll('[data-toggle-hw]').forEach((cb) => {
          cb.addEventListener('change', () => {
            const id = cb.getAttribute('data-toggle-hw');
            this.toggleHomeworkDone(id, cb.checked);
          });
        });
      }
    }

    // 3. Dashboard Report Card Prediction Summary
    const reportSummaryEl = document.getElementById('dash-report-card-summary');
    if (reportSummaryEl) {
      const report = window.BakalariPWA.analyzeOverallReportCard(
        this.schoolData?.marks?.Subjects || [],
        this.whatIfMarks,
        this.gradeThresholdOffset
      );

      const avgFormatted = report.overallFinalAverage !== null
        ? report.overallFinalAverage.toFixed(2).replace('.', ',')
        : '—';

      reportSummaryEl.innerHTML = `
        <div class="report-hero-box ${report.verdictBadge}">
          <div class="report-score-circle">
            <span class="score-num">${avgFormatted}</span>
            <span class="score-label">Odhad průměru</span>
          </div>
          <div class="report-verdict-info">
            <span class="verdict-title">${window.escapeHtml(report.verdict)}</span>
            <p>${window.escapeHtml(report.verdictDetail)}</p>
            <div class="grade-chips-mini">
              <span class="g-chip g1">Jedničky: <strong>${report.gradeCounts[1]}×</strong></span>
              <span class="g-chip g2">Dvojky: <strong>${report.gradeCounts[2]}×</strong></span>
              ${report.gradeCounts[3] > 0 ? `<span class="g-chip g3">Trojky: <strong>${report.gradeCounts[3]}×</strong></span>` : ''}
            </div>
          </div>
        </div>
      `;
    }
  }

  /* ========================================================================
     TIMETABLE & EXTRACURRICULAR CLUBS (ROZVRH A KROUŽKY)
     ======================================================================== */

  renderTimetableSection() {
    // Render day switcher buttons
    const dayTabsEl = document.getElementById('timetable-day-tabs');
    if (dayTabsEl) {
      const monday = window.BakalariPWA.getMondayOfWeek(new Date());
      monday.setDate(monday.getDate() + this.weekOffset * 7);

      let tabsHtml = '';
      for (let d = 1; d <= 5; d++) {
        const dayDate = new Date(monday);
        dayDate.setDate(monday.getDate() + (d - 1));
        const dateShort = dayDate.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
        const clubsCount = this.clubs.filter((c) => Number(c.dayOfWeek) === d).length;
        const activeClass = this.selectedDayOfWeek === d ? 'active' : '';

        tabsHtml += `
          <button type="button" class="day-tab-btn ${activeClass}" data-select-day="${d}">
            <span class="day-tab-name">${DAY_NAMES_CS[d]}</span>
            <span class="day-tab-date">${dateShort}${clubsCount > 0 ? ` • 🎨${clubsCount}` : ''}</span>
          </button>
        `;
      }
      dayTabsEl.innerHTML = tabsHtml;
      dayTabsEl.hidden = this.timetableViewMode === 'weekly';

      dayTabsEl.querySelectorAll('[data-select-day]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this.selectedDayOfWeek = Number(btn.getAttribute('data-select-day'));
          this.renderTimetableSection();
        });
      });
    }

    const container = document.getElementById('timetable-content-area');
    if (!container) return;

    if (this.timetableViewMode === 'daily') {
      const schedule = this.getDayScheduleWithClubs(this.selectedDayOfWeek);
      let html = `
        <div class="timetable-day-header">
          <div>
            <h3>${schedule.dayLabel} (${schedule.dateFormatted})</h3>
            <p>${schedule.lessons.length} vyučovacích hodin • ${schedule.clubs.length} ${schedule.clubs.length === 1 ? 'odpolední kroužek' : 'odpolední kroužky'}</p>
          </div>
          <button type="button" class="btn-primary-sm" data-open-club-modal="${schedule.dayOfWeek}">
            + Přidat kroužek na ${schedule.dayLabel.toLowerCase()}
          </button>
        </div>
      `;

      if (schedule.lessons.length === 0) {
        html += `<div class="empty-card">V tento den není v Bakalářích zapsané žádné vyučování.</div>`;
      } else {
        html += `<div class="timetable-timeline">`;
        for (const l of schedule.lessons) {
          html += `
            <article class="timeline-card ${l.change ? 'has-change' : ''} ${l.isCancelled ? 'is-cancelled' : ''}">
              <div class="timeline-hour">
                <span class="hour-circle">${window.escapeHtml(l.hourCaption)}.</span>
                <span class="hour-times">${window.escapeHtml(l.beginTime)} – ${window.escapeHtml(l.endTime)}</span>
              </div>
              <div class="timeline-body">
                <div class="timeline-top-row">
                  <span class="subj-badge-lg">${window.escapeHtml(l.subjectAbbrev)}</span>
                  <h4>${window.escapeHtml(l.subjectName)}</h4>
                  <span class="room-pill" title="${window.escapeHtml(l.roomName)}">📍 Učebna ${window.escapeHtml(l.roomAbbrev || '—')}</span>
                </div>
                <div class="timeline-details">
                  ${l.teacherName ? `<span>👩‍🏫 ${window.escapeHtml(l.teacherName)}</span>` : ''}
                  ${l.theme ? `<span>📖 Probírané učivo: <em>${window.escapeHtml(l.theme)}</em></span>` : ''}
                </div>
                ${l.change ? `
                  <div class="timeline-change-alert">
                    ⚠️ <strong>Změna v rozvrhu:</strong> ${window.escapeHtml(l.change.Description || l.change.ChangeType)}
                  </div>
                ` : ''}
              </div>
            </article>
          `;
        }
        html += `</div>`;
      }

      // Render afternoon clubs for this day
      html += `
        <div class="clubs-section-block">
          <div class="clubs-header-row">
            <h4>🎨 Odpolední kroužky a aktivity (${schedule.dayLabel})</h4>
          </div>
      `;

      if (schedule.clubs.length === 0) {
        html += `
          <div class="empty-clubs-box">
            <p>Na ${schedule.dayLabel.toLowerCase()} zatím nemáš přidaný žádný odpolední kroužek.</p>
            <button type="button" class="btn-outline-sm" data-open-club-modal="${schedule.dayOfWeek}">+ Přidat kroužek</button>
          </div>
        `;
      } else {
        html += `<div class="clubs-cards-grid">`;
        for (const club of schedule.clubs) {
          html += `
            <article class="club-card" style="--club-color: ${window.escapeHtml(club.color || '#8b5cf6')}">
              <div class="club-card-main">
                <div class="club-time-badge">🕒 ${window.escapeHtml(club.beginTime)} – ${window.escapeHtml(club.endTime)}</div>
                <h5>🌟 ${window.escapeHtml(club.name)}</h5>
                <p class="club-meta">📍 Místo: <strong>${window.escapeHtml(club.location || 'Neuvedeno')}</strong></p>
                ${club.equipment ? `<p class="club-equip">🎒 Co s sebou: <strong>${window.escapeHtml(club.equipment)}</strong></p>` : ''}
              </div>
              <div class="club-card-actions">
                <button type="button" class="btn-icon-action" data-edit-club="${window.escapeHtml(club.id)}" title="Upravit kroužek" aria-label="Upravit kroužek">✏️</button>
                <button type="button" class="btn-icon-action danger" data-delete-club="${window.escapeHtml(club.id)}" title="Smazat kroužek" aria-label="Smazat kroužek">🗑️</button>
              </div>
            </article>
          `;
        }
        html += `</div>`;
      }
      html += `</div>`;

      container.innerHTML = html;
    } else {
      // Weekly Grid View (Pondělí - Pátek)
      const hours = this.schoolData?.timetable?.Hours || [];
      let html = `
        <div class="weekly-grid-wrapper">
          <table class="weekly-timetable-table">
            <thead>
              <tr>
                <th>Den</th>
                ${hours.map((h) => `
                  <th>
                    <div class="th-hour-num">${window.escapeHtml(h.Caption)}.</div>
                    <div class="th-hour-time">${window.escapeHtml(h.BeginTime)}–${window.escapeHtml(h.EndTime)}</div>
                  </th>
                `).join('')}
                <th>🎨 Odpolední kroužky</th>
              </tr>
            </thead>
            <tbody>
      `;

      for (let d = 1; d <= 5; d++) {
        const sched = this.getDayScheduleWithClubs(d);
        const lessonByHour = new Map(sched.lessons.map((l) => [Number(l.hourId), l]));

        html += `
          <tr>
            <td class="td-day-name">
              <strong>${sched.dayLabel}</strong>
              <span>${sched.dateFormatted}</span>
            </td>
            ${hours.map((h) => {
              const l = lessonByHour.get(Number(h.Id));
              if (!l) return `<td class="td-empty"></td>`;
              return `
                <td class="td-lesson-cell ${l.change ? 'has-change' : ''} ${l.isCancelled ? 'is-cancelled' : ''}">
                  <div class="cell-subj" title="${window.escapeHtml(l.subjectName)}">${window.escapeHtml(l.subjectAbbrev)}</div>
                  <div class="cell-room">${window.escapeHtml(l.roomAbbrev)}</div>
                  ${l.change ? `<span class="cell-change-dot" title="${window.escapeHtml(l.change.Description)}">!</span>` : ''}
                </td>
              `;
            }).join('')}
            <td class="td-clubs-cell">
              ${sched.clubs.map((c) => `
                <div class="mini-club-pill" style="--club-color: ${window.escapeHtml(c.color || '#8b5cf6')}">
                  <strong>${window.escapeHtml(c.beginTime)}</strong> ${window.escapeHtml(c.name)}
                </div>
              `).join('')}
              <button type="button" class="btn-mini-add-club" data-open-club-modal="${d}">+ Kroužek</button>
            </td>
          </tr>
        `;
      }

      html += `
            </tbody>
          </table>
        </div>
      `;
      container.innerHTML = html;
    }

    // Bind club modal buttons
    container.querySelectorAll('[data-open-club-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const day = Number(btn.getAttribute('data-open-club-modal')) || this.selectedDayOfWeek;
        this.openClubModal(null, day);
      });
    });

    container.querySelectorAll('[data-edit-club]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const clubId = btn.getAttribute('data-edit-club');
        const club = this.clubs.find((c) => c.id === clubId);
        if (club) this.openClubModal(club);
      });
    });

    container.querySelectorAll('[data-delete-club]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const clubId = btn.getAttribute('data-delete-club');
        this.deleteClub(clubId);
      });
    });
  }

  /* ========================================================================
     MARKS & ESTIMATED REPORT CARD (ZNÁMKY A ODHAD VYSVĚDČENÍ)
     ======================================================================== */

  renderMarksSection() {
    const summaryContainer = document.getElementById('marks-report-summary');
    const subjectsContainer = document.getElementById('marks-subjects-list');
    if (!summaryContainer || !subjectsContainer) return;

    const report = window.BakalariPWA.analyzeOverallReportCard(
      this.schoolData?.marks?.Subjects || [],
      this.whatIfMarks,
      this.gradeThresholdOffset
    );

    const hasAnyWhatIf = Object.values(this.whatIfMarks).some((arr) => arr && arr.length > 0);
    const finalAvgStr = report.overallFinalAverage !== null
      ? report.overallFinalAverage.toFixed(2).replace('.', ',')
      : '—';
    const contAvgStr = report.overallContinuousAverage !== null
      ? report.overallContinuousAverage.toFixed(2).replace('.', ',')
      : '—';

    summaryContainer.innerHTML = `
      <div class="report-overview-panel ${report.verdictBadge}">
        <div class="report-metrics-grid">
          <div class="metric-card highlight">
            <span class="metric-label">Odhad průměru na vysvědčení</span>
            <strong class="metric-value">${finalAvgStr}</strong>
            <span class="metric-sub">${window.escapeHtml(report.verdict)}</span>
          </div>
          <div class="metric-card">
            <span class="metric-label">Průběžný průměr předmětů</span>
            <strong class="metric-value">${contAvgStr}</strong>
            <span class="metric-sub">Hranice zaokrouhlení: ,${Math.round(this.gradeThresholdOffset * 100)}</span>
          </div>
          <div class="metric-card">
            <span class="metric-label">Rozložení známek na vysvědčení</span>
            <div class="grade-distribution-pills">
              <span class="dist-pill g1">1: <strong>${report.gradeCounts[1]}×</strong></span>
              <span class="dist-pill g2">2: <strong>${report.gradeCounts[2]}×</strong></span>
              <span class="dist-pill g3">3: <strong>${report.gradeCounts[3]}×</strong></span>
              <span class="dist-pill g4">4: <strong>${report.gradeCounts[4]}×</strong></span>
              <span class="dist-pill g5">5: <strong>${report.gradeCounts[5]}×</strong></span>
            </div>
            <span class="metric-sub">${window.escapeHtml(report.verdictDetail)}</span>
          </div>
        </div>
        ${hasAnyWhatIf ? `
          <div class="whatif-active-banner">
            <span>🧪 <strong>Je zapnutá simulace známek nanečisto („Co když dostanu...“).</strong></span>
            <button type="button" class="btn-clear-whatif" id="btn-reset-all-whatif">Vymazat zkušební známky</button>
          </div>
        ` : ''}
      </div>
    `;

    const resetBtn = document.getElementById('btn-reset-all-whatif');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        this.whatIfMarks = {};
        this.renderMarksSection();
        this.renderDashboard();
      });
    }

    // Render individual subjects
    subjectsContainer.innerHTML = report.subjects.map((subjAnalysis) => {
      const subjId = subjAnalysis.subject.Id || subjAnalysis.subject.Abbrev;
      const estGrade = subjAnalysis.estimatedGrade || '—';
      const gradeClass = `grade-bg-${estGrade}`;

      return `
        <article class="subject-marks-card">
          <div class="subject-card-header">
            <div class="subject-title-group">
              <span class="subj-abbrev-box">${window.escapeHtml(subjAnalysis.subject.Abbrev)}</span>
              <div>
                <h3>${window.escapeHtml(subjAnalysis.subject.Name)}</h3>
                <p class="subject-advice ${subjAnalysis.statusType}">💡 ${window.escapeHtml(subjAnalysis.adviceText)}</p>
              </div>
            </div>
            <div class="subject-averages-group">
              <div class="avg-box">
                <span class="avg-label">Vážený průměr</span>
                <strong class="avg-val">${window.escapeHtml(subjAnalysis.formattedAverage)}</strong>
              </div>
              <div class="report-grade-box ${gradeClass}" title="Odhadovaná známka na vysvědčení">
                <span class="rg-label">Vysvědčení</span>
                <strong class="rg-val">${estGrade}</strong>
              </div>
            </div>
          </div>

          <div class="marks-badges-row">
            ${subjAnalysis.marks.length === 0 ? `<span class="empty-note">Zatím žádné známky</span>` : ''}
            ${subjAnalysis.marks.map((m, idx) => {
              const numGrade = Math.round(m.numericValue || 1);
              return `
                <div class="mark-chip g-chip-${numGrade} ${m.isWhatIf ? 'is-whatif' : ''}" title="${window.escapeHtml(m.Caption || '')} – ${window.escapeHtml(m.Theme || '')} (váha ${m.effectiveWeight})">
                  <span class="mark-chip-val">${window.escapeHtml(m.MarkText)}</span>
                  <span class="mark-chip-weight">v.${m.effectiveWeight}</span>
                  <span class="mark-chip-caption">${window.escapeHtml(m.Caption || m.Theme || 'Známka')}</span>
                  ${m.IsNew ? `<span class="mark-new-dot">NOVÁ</span>` : ''}
                  ${m.isWhatIf ? `<button type="button" class="mark-remove-whatif" data-remove-whatif="${window.escapeHtml(subjId)}" data-whatif-idx="${m.whatIfIndex}" aria-label="Odebrat zkušební známku">×</button>` : ''}
                </div>
              `;
            }).join('')}
          </div>

          <div class="whatif-controls-row">
            <span class="whatif-label">🧪 Vyzkoušet známku nanečisto:</span>
            <div class="whatif-quick-btns">
              <button type="button" class="btn-whatif g1" data-add-whatif="${window.escapeHtml(subjId)}" data-mark="1" data-weight="5">+ 1 (váha 5)</button>
              <button type="button" class="btn-whatif g1" data-add-whatif="${window.escapeHtml(subjId)}" data-mark="1" data-weight="10">+ 1 (velký test v.10)</button>
              <button type="button" class="btn-whatif g2" data-add-whatif="${window.escapeHtml(subjId)}" data-mark="2" data-weight="5">+ 2 (váha 5)</button>
              <button type="button" class="btn-whatif g3" data-add-whatif="${window.escapeHtml(subjId)}" data-mark="3" data-weight="5">+ 3 (váha 5)</button>
            </div>
          </div>
        </article>
      `;
    }).join('');

    // Bind What-If simulation buttons
    subjectsContainer.querySelectorAll('[data-add-whatif]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const subjId = btn.getAttribute('data-add-whatif');
        const mark = btn.getAttribute('data-mark');
        const weight = Number(btn.getAttribute('data-weight')) || 5;
        if (!this.whatIfMarks[subjId]) this.whatIfMarks[subjId] = [];
        const whatIfIndex = this.whatIfMarks[subjId].length;
        this.whatIfMarks[subjId].push({
          MarkText: mark,
          Weight: weight,
          Caption: 'Zkušební známka',
          isWhatIf: true,
          whatIfIndex
        });
        this.renderMarksSection();
        this.renderDashboard();
      });
    });

    subjectsContainer.querySelectorAll('[data-remove-whatif]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const subjId = btn.getAttribute('data-remove-whatif');
        const idx = Number(btn.getAttribute('data-whatif-idx'));
        if (this.whatIfMarks[subjId]) {
          this.whatIfMarks[subjId].splice(idx, 1);
          // Re-index remaining whatIf marks
          this.whatIfMarks[subjId].forEach((item, i) => { item.whatIfIndex = i; });
          this.renderMarksSection();
          this.renderDashboard();
        }
      });
    });
  }

  /* ========================================================================
     HOMEWORKS SECTION (DOMÁCÍ ÚKOLY)
     ======================================================================== */

  renderHomeworksSection() {
    const container = document.getElementById('homeworks-list-container');
    if (!container) return;

    const allHw = this.getAllNormalizedHomeworks();
    const nextSchoolDayIso = window.BakalariPWA.formatDateIso(window.BakalariPWA.getNextSchoolDay());
    const todayIso = window.BakalariPWA.formatDateIso(new Date());

    let filtered = allHw;
    if (this.hwFilter === 'active') {
      filtered = allHw.filter((h) => !h.isDone);
    } else if (this.hwFilter === 'tomorrow') {
      filtered = allHw.filter((h) => h.dueIso === nextSchoolDayIso || h.dueIso === todayIso);
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-celebration">
          <span aria-hidden="true">✨</span>
          <h3>Žádné úkoly v tomto přehledu!</h3>
          <p>Všechny úkoly máš splněné nebo na tento den nebyl žádný zadán.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map((hw) => {
      const isUrgent = !hw.isDone && (hw.dueIso <= nextSchoolDayIso);
      return `
        <article class="homework-card ${hw.isDone ? 'is-completed' : ''} ${isUrgent ? 'is-urgent' : ''}">
          <label class="hw-checkbox-column">
            <input type="checkbox" class="hw-large-checkbox" data-hw-check="${window.escapeHtml(hw.Id)}" ${hw.isDone ? 'checked' : ''}>
            <span class="hw-status-label">${hw.isDone ? 'Hotovo' : 'Splnit'}</span>
          </label>
          <div class="hw-main-column">
            <div class="hw-meta-row">
              <span class="subj-pill">${window.escapeHtml(hw.subjectAbbrev)}</span>
              <h4>${window.escapeHtml(hw.subjectName)}</h4>
              <span class="hw-due-badge ${isUrgent ? 'urgent' : ''}">
                📅 Termín: ${window.escapeHtml(hw.dueDateFormatted)}
              </span>
              ${hw.isCustom ? `
                <button type="button" class="btn-delete-custom-hw" data-del-custom-hw="${window.escapeHtml(hw.Id)}" title="Smazat vlastní úkol">🗑️</button>
              ` : ''}
            </div>
            <p class="hw-description">${window.escapeHtml(hw.Content)}</p>
            ${hw.teacherName ? `<span class="hw-teacher">Zadal(a): ${window.escapeHtml(hw.teacherName)}</span>` : ''}
          </div>
        </article>
      `;
    }).join('');

    container.querySelectorAll('[data-hw-check]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.getAttribute('data-hw-check');
        this.toggleHomeworkDone(id, cb.checked);
      });
    });

    container.querySelectorAll('[data-del-custom-hw]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del-custom-hw');
        this.customHomeworks = this.customHomeworks.filter((h) => h.id !== id);
        this.saveCustomHomeworks();
        this.renderHomeworksSection();
        this.renderDashboard();
      });
    });
  }

  toggleHomeworkDone(hwId, isDone) {
    this.hwDoneMap[hwId] = isDone;
    this.saveHwDoneMap();
    this.renderHomeworksSection();
    this.renderDashboard();
    this.showToast(isDone ? '✅ Úkol označen jako splněný!' : 'Úkol vrácen mezi rozpracované.');
  }

  /* ========================================================================
     SETTINGS & BAKALÁŘI LOGIN SECTION
     ======================================================================== */

  renderSettingsSection() {
    const urlInput = document.getElementById('input-baka-url');
    const userInput = document.getElementById('input-baka-user');
    const proxyInput = document.getElementById('input-baka-proxy');
    const connStateEl = document.getElementById('baka-connection-status');

    if (urlInput && !urlInput.value) urlInput.value = this.api.auth.schoolUrl || '';
    if (userInput && !userInput.value) userInput.value = this.api.auth.username || '';
    if (proxyInput && !proxyInput.value) proxyInput.value = this.api.auth.proxyUrl || '';

    if (connStateEl) {
      if (this.api.isLiveMode()) {
        connStateEl.innerHTML = `
          <div class="conn-banner live">
            <span>🟢 <strong>Připojeno k Bakalářům:</strong> ${window.escapeHtml(this.api.auth.schoolUrl)} (uživatel: <strong>${window.escapeHtml(this.api.auth.username)}</strong>)</span>
            <button type="button" class="btn-outline-sm" id="btn-logout-baka">Odpojit a přepnout na Demo</button>
          </div>
        `;
        const logoutBtn = document.getElementById('btn-logout-baka');
        if (logoutBtn) {
          logoutBtn.addEventListener('click', () => {
            this.api.logout();
            this.refreshData();
            this.showToast('Odpojeno. Aplikace nyní běží v ukázkovém režimu.');
          });
        }
      } else {
        connStateEl.innerHTML = `
          <div class="conn-banner demo">
            <span>🟣 <strong>Aktuálně je aktivní Ukázkový režim (Demo ZŠ).</strong> Zadejte níže přihlašovací údaje do školních Bakalářů pro načtení skutečných dat dcery.</span>
          </div>
        `;
      }
    }

    // Notification schedule inputs
    const nameInput = document.getElementById('setting-student-name');
    const morningInput = document.getElementById('setting-morning-time');
    const hwInput = document.getElementById('setting-homework-time');
    const eveningInput = document.getElementById('setting-evening-time');
    const soundInput = document.getElementById('setting-sound-enabled');
    const reqCheckInput = document.getElementById('setting-require-ticks');

    if (nameInput) nameInput.value = this.notifier.settings.studentName || 'Eliško';
    if (morningInput) morningInput.value = this.notifier.settings.morningTime || '07:00';
    if (hwInput) hwInput.value = this.notifier.settings.homeworkTime || '17:00';
    if (eveningInput) eveningInput.value = this.notifier.settings.eveningTime || '19:30';
    if (soundInput) soundInput.checked = Boolean(this.notifier.settings.soundEnabled);
    if (reqCheckInput) reqCheckInput.checked = Boolean(this.notifier.settings.requireChecklistTicks);

    this.updateNotificationPermissionBadge();
  }

  updateNotificationPermissionBadge() {
    const badge = document.getElementById('notif-permission-status');
    if (!badge) return;
    if (!('Notification' in window)) {
      badge.textContent = 'Prohlížeč nepodporuje Web Notifications (fungují vyskakovací okna v aplikaci)';
      badge.className = 'perm-badge warning';
    } else if (Notification.permission === 'granted') {
      badge.textContent = '✅ Systémové vyskakovací notifikace jsou povolené';
      badge.className = 'perm-badge granted';
    } else {
      badge.textContent = '⚠️ Klikněte na „Povolit systémová upozornění“ pro notifikace na pozadí';
      badge.className = 'perm-badge pending';
    }
  }

  /* ========================================================================
     MODALS FOR ADDING KROUŽKY & CUSTOM HOMEWORK
     ======================================================================== */

  openClubModal(existingClub = null, defaultDay = 1) {
    const dialog = document.getElementById('club-editor-dialog');
    if (!dialog) return;

    document.getElementById('club-modal-heading').textContent = existingClub ? 'Upravit kroužek' : 'Přidat nový kroužek do rozvrhu';
    document.getElementById('club-id-input').value = existingClub ? existingClub.id : '';
    document.getElementById('club-name-input').value = existingClub ? existingClub.name : '';
    document.getElementById('club-day-input').value = existingClub ? String(existingClub.dayOfWeek) : String(defaultDay);
    document.getElementById('club-begin-input').value = existingClub ? existingClub.beginTime : '14:30';
    document.getElementById('club-end-input').value = existingClub ? existingClub.endTime : '16:00';
    document.getElementById('club-location-input').value = existingClub ? (existingClub.location || '') : '';
    document.getElementById('club-equipment-input').value = existingClub ? (existingClub.equipment || '') : '';
    document.getElementById('club-color-input').value = existingClub ? (existingClub.color || '#ec4899') : '#ec4899';

    dialog.showModal();
  }

  deleteClub(clubId) {
    this.clubs = this.clubs.filter((c) => c.id !== clubId);
    window.BakalariPWA.saveCustomClubs(this.clubs);
    this.renderTimetableSection();
    this.renderDashboard();
    this.showToast('Kroužek byl odebrán z rozvrhu.');
  }

  /* ========================================================================
     EVENT BINDINGS & NAVIGATION
     ======================================================================== */

  bindNavigation() {
    document.querySelectorAll('[data-nav-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-nav-tab');
        this.switchTab(targetTab);
      });
    });
  }

  switchTab(tabId) {
    this.activeTab = tabId;
    document.querySelectorAll('[data-nav-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-nav-tab') === tabId);
    });
    document.querySelectorAll('.app-view-section').forEach((sec) => {
      sec.hidden = sec.id !== `view-${tabId}`;
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  bindGlobalActions() {
    // Refresh data button
    const refreshBtn = document.getElementById('btn-refresh-data');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.refreshData().then(() => this.showToast('Rozvrh, známky a úkoly byly aktualizovány.'));
      });
    }

    // Timetable view mode toggle (Daily vs Weekly)
    document.querySelectorAll('[data-tt-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.timetableViewMode = btn.getAttribute('data-tt-mode');
        document.querySelectorAll('[data-tt-mode]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-tt-mode') === this.timetableViewMode);
        });
        this.renderTimetableSection();
      });
    });

    // Week switcher (This week vs Next week)
    document.querySelectorAll('[data-week-offset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.weekOffset = Number(btn.getAttribute('data-week-offset')) || 0;
        document.querySelectorAll('[data-week-offset]').forEach((b) => {
          b.classList.toggle('active', Number(b.getAttribute('data-week-offset')) === this.weekOffset);
        });
        this.refreshData();
      });
    });

    // Top-level "+ Přidat kroužek" button
    const addClubBtn = document.getElementById('btn-add-club-main');
    if (addClubBtn) {
      addClubBtn.addEventListener('click', () => this.openClubModal(null, this.selectedDayOfWeek));
    }

    // Save Club Form
    const clubForm = document.getElementById('club-editor-form');
    if (clubForm) {
      clubForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = document.getElementById('club-id-input').value || `club_${Date.now()}`;
        const newClub = {
          id,
          name: document.getElementById('club-name-input').value.trim(),
          dayOfWeek: Number(document.getElementById('club-day-input').value) || 1,
          beginTime: document.getElementById('club-begin-input').value || '14:30',
          endTime: document.getElementById('club-end-input').value || '16:00',
          location: document.getElementById('club-location-input').value.trim(),
          equipment: document.getElementById('club-equipment-input').value.trim(),
          color: document.getElementById('club-color-input').value || '#ec4899'
        };

        const existingIdx = this.clubs.findIndex((c) => c.id === id);
        if (existingIdx >= 0) {
          this.clubs[existingIdx] = newClub;
        } else {
          this.clubs.push(newClub);
        }

        window.BakalariPWA.saveCustomClubs(this.clubs);
        this.selectedDayOfWeek = newClub.dayOfWeek;
        document.getElementById('club-editor-dialog').close();
        this.renderTimetableSection();
        this.renderDashboard();
        this.showToast(`Kroužek „${newClub.name}“ byl uložen do rozvrhu!`);
      });
    }

    const cancelClubBtn = document.getElementById('btn-cancel-club-modal');
    if (cancelClubBtn) {
      cancelClubBtn.addEventListener('click', () => {
        document.getElementById('club-editor-dialog').close();
      });
    }

    // Homework Filter Tabs
    document.querySelectorAll('[data-hw-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.hwFilter = btn.getAttribute('data-hw-filter');
        document.querySelectorAll('[data-hw-filter]').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-hw-filter') === this.hwFilter);
        });
        this.renderHomeworksSection();
      });
    });

    // Custom Homework Modal
    const openHwModalBtn = document.getElementById('btn-open-custom-hw-modal');
    const hwDialog = document.getElementById('custom-hw-dialog');
    if (openHwModalBtn && hwDialog) {
      openHwModalBtn.addEventListener('click', () => {
        const nextDayIso = window.BakalariPWA.formatDateIso(window.BakalariPWA.getNextSchoolDay());
        document.getElementById('custom-hw-date').value = nextDayIso;
        document.getElementById('custom-hw-content').value = '';
        hwDialog.showModal();
      });
    }

    const cancelHwModalBtn = document.getElementById('btn-cancel-custom-hw');
    if (cancelHwModalBtn && hwDialog) {
      cancelHwModalBtn.addEventListener('click', () => hwDialog.close());
    }

    const customHwForm = document.getElementById('custom-hw-form');
    if (customHwForm) {
      customHwForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const subjSelect = document.getElementById('custom-hw-subject');
        const selectedOption = subjSelect.options[subjSelect.selectedIndex];
        const subjectAbbrev = subjSelect.value;
        const subjectName = selectedOption ? selectedOption.textContent : 'Vlastní úkol';
        const dueIso = document.getElementById('custom-hw-date').value;
        const content = document.getElementById('custom-hw-content').value.trim();

        if (!content) return;

        this.customHomeworks.push({
          id: `chw_${Date.now()}`,
          subjectAbbrev,
          subjectName,
          dueIso: dueIso || window.BakalariPWA.formatDateIso(window.BakalariPWA.getNextSchoolDay()),
          content,
          isDone: false
        });
        this.saveCustomHomeworks();
        hwDialog.close();
        this.renderHomeworksSection();
        this.renderDashboard();
        this.showToast('Vlastní domácí úkol byl přidán!');
      });
    }

    // Grade rounding threshold selector
    const thresholdSelect = document.getElementById('marks-threshold-select');
    if (thresholdSelect) {
      thresholdSelect.addEventListener('change', () => {
        this.gradeThresholdOffset = parseFloat(thresholdSelect.value) || 0.5;
        this.renderMarksSection();
        this.renderDashboard();
      });
    }

    // Bakaláři Login Form
    const loginForm = document.getElementById('bakalari-login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = document.getElementById('input-baka-url').value;
        const user = document.getElementById('input-baka-user').value;
        const pass = document.getElementById('input-baka-pass').value;
        const proxy = document.getElementById('input-baka-proxy').value;
        const submitBtn = document.getElementById('btn-submit-baka-login');

        submitBtn.disabled = true;
        submitBtn.textContent = 'Přihlašuji k Bakalářům...';

        try {
          await this.api.login(url, user, pass, proxy);
          document.getElementById('input-baka-pass').value = '';
          await this.refreshData();
          this.showToast('✅ Úspěšně připojeno ke školnímu systému Bakaláři!');
        } catch (err) {
          this.showToast(err.message, 'error');
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Připojit k Bakalářům API v3';
        }
      });
    }

    // Save Notification Settings Form
    const notifForm = document.getElementById('notification-settings-form');
    if (notifForm) {
      notifForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.notifier.saveSettings({
          studentName: document.getElementById('setting-student-name').value.trim() || 'Eliško',
          morningTime: document.getElementById('setting-morning-time').value || '07:00',
          homeworkTime: document.getElementById('setting-homework-time').value || '17:00',
          eveningTime: document.getElementById('setting-evening-time').value || '19:30',
          soundEnabled: document.getElementById('setting-sound-enabled').checked,
          requireChecklistTicks: document.getElementById('setting-require-ticks').checked
        });
        this.renderAll();
        this.showToast('⚙️ Nastavení časů upozornění bylo uloženo!');
      });
    }

    // Request Browser Notification Permission button
    const reqPermBtn = document.getElementById('btn-request-notif-permission');
    if (reqPermBtn) {
      reqPermBtn.addEventListener('click', async () => {
        const res = await this.notifier.requestPermission();
        this.updateNotificationPermissionBadge();
        if (res === 'granted') {
          this.showToast('🔔 Systémové vyskakovací notifikace byly povoleny!');
        } else {
          this.showToast('Notifikace nebyly povoleny v prohlížeči, vyskakovací okna v aplikaci však fungují vždy.', 'error');
        }
      });
    }

    // Test Notification Buttons in Settings/Header
    document.querySelectorAll('[data-test-alert]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-test-alert');
        this.notifier.triggerAlert(type, true);
      });
    });

    // Force Cache Reload button in Footer
    const forceReloadBtn = document.getElementById('btn-force-cache-reload');
    if (forceReloadBtn) {
      forceReloadBtn.addEventListener('click', async () => {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const reg of regs) {
            await reg.unregister();
          }
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          for (const k of keys) {
            await caches.delete(k);
          }
        }
        window.location.reload(true);
      });
    }
  }

  showToast(message, type = 'success') {
    const toast = document.getElementById('app-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `app-toast show ${type}`;
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 4000);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new SkolniPartakApp();
  window.skolniPartakApp = app;
  app.init();
});

