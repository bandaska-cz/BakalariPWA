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

    this.familyConfig = this.loadFamilyConfig();
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

  loadFamilyConfig() {
    try {
      const raw = localStorage.getItem(window.BakalariPWA.STORAGE_KEYS.FAMILY_SYNC);
      if (raw) {
        return {
          role: 'parent',
          familyId: 'BUNDA',
          workerUrl: 'https://mute-cloud-b42b.radek-bunda.workers.dev',
          activePin: '',
          parentPin: '',
          childPin: '',
          shareBakalariAuth: false,
          ownBakalariLogin: false,
          ...JSON.parse(raw)
        };
      }
    } catch (_) {}
    return {
      role: 'parent', // 'parent' | 'child'
      familyId: 'BUNDA',
      workerUrl: 'https://mute-cloud-b42b.radek-bunda.workers.dev',
      activePin: '',
      parentPin: '',
      childPin: '',
      shareBakalariAuth: false,
      ownBakalariLogin: false
    };
  }

  generateRandomFamilyId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let suffix = '';
    const arr = new Uint8Array(4);
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(arr);
      for (let i = 0; i < 4; i++) suffix += chars[arr[i] % chars.length];
    } else {
      for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    return `RODINA-${suffix}`;
  }

  saveFamilyConfig(updates = {}) {
    this.familyConfig = { ...this.familyConfig, ...updates };
    localStorage.setItem(window.BakalariPWA.STORAGE_KEYS.FAMILY_SYNC, JSON.stringify(this.familyConfig));
  }

  isParentMode() {
    return this.familyConfig.role !== 'child';
  }

  async applyCloudState(state, roleOverride = null) {
    if (!state) return;
    const effectiveRole = roleOverride || this.familyConfig.role || 'parent';

    if (typeof state.shareBakalariAuth === 'boolean') {
      this.saveFamilyConfig({ shareBakalariAuth: state.shareBakalariAuth });
    }

    // Use shared Bakaláři token from Family Cloud when in Child Mode
    // OR when this parent phone has not logged in with its own separate Bakaláři account yet.
    const useSharedToken = effectiveRole === 'child' || !this.familyConfig.ownBakalariLogin || !this.api.isLiveMode();

    if (useSharedToken && state.shareBakalariAuth) {
      if (state.encryptedBakalariAuth && this.familyConfig.activePin) {
        const decrypted = await this.api.decryptAuthFromBundle(
          state.encryptedBakalariAuth,
          this.familyConfig.familyId,
          this.familyConfig.activePin,
          effectiveRole
        );
        if (decrypted && decrypted.accessToken) {
          this.api.saveAuth(decrypted);
        }
      } else if (state.bakalariAuth && state.bakalariAuth.accessToken) {
        this.api.saveAuth(state.bakalariAuth);
      }
    }

    if (Array.isArray(state.clubs)) {
      this.clubs = state.clubs;
      window.BakalariPWA.saveCustomClubs(this.clubs);
    }
    if (Array.isArray(state.customHomeworks)) {
      this.customHomeworks = state.customHomeworks;
      this.saveCustomHomeworks();
    }
    if (state.hwDoneMap) {
      this.hwDoneMap = { ...this.hwDoneMap, ...state.hwDoneMap };
      this.saveHwDoneMap();
    }
    if (state.confirmations) {
      this.notifier.confirmations = { ...this.notifier.confirmations, ...state.confirmations };
      this.notifier.saveConfirmations();
    }
    if (state.settings) {
      this.notifier.saveSettings(state.settings);
    }
  }

  async pullFamilySync() {
    if (!this.familyConfig.activePin || !this.familyConfig.workerUrl || !this.familyConfig.familyId) return;
    if (String(this.familyConfig.activePin).trim().length < 8) return;
    try {
      const res = await this.api.connectWithFamilyPin(
        this.familyConfig.workerUrl,
        this.familyConfig.familyId,
        this.familyConfig.activePin
      );
      if (res && res.state) {
        await this.applyCloudState(res.state, res.role);
      }
    } catch (e) {
      console.warn('Synchronizace z rodinného cloudu selhala:', e);
    }
  }

  async pushFamilySync(includeAuth = false) {
    if (!this.familyConfig.activePin || !this.familyConfig.workerUrl || !this.familyConfig.familyId) return;
    if (String(this.familyConfig.activePin).trim().length < 8) return;
    try {
      const payload = {
        clubs: this.clubs,
        customHomeworks: this.customHomeworks,
        hwDoneMap: this.hwDoneMap,
        confirmations: this.notifier.confirmations,
        settings: this.notifier.settings
      };

      if (includeAuth && this.familyConfig.shareBakalariAuth && this.api.isLiveMode()) {
        const parentPin = this.familyConfig.parentPin || this.familyConfig.activePin;
        const childPin = this.familyConfig.childPin || '';
        payload.shareBakalariAuth = true;
        payload.encryptedBakalariAuth = await this.api.createEncryptedAuthBundle(
          this.api.auth,
          this.familyConfig.familyId,
          parentPin,
          childPin
        );
        payload.bakalariAuth = null;
      }

      const res = await this.api.syncFamilyState(
        this.familyConfig.workerUrl,
        this.familyConfig.familyId,
        this.familyConfig.activePin,
        payload
      );
      if (res && res.state) {
        await this.applyCloudState(res.state, res.role);
      }
    } catch (e) {
      console.warn('Zápis do rodinného cloudu selhal:', e);
    }
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
    this.initAriaValidationSync();
    this.bindNavigation();
    this.bindGlobalActions();

    // Check URL query param ?family=KOD_RODINY for 1-click family onboarding
    const params = new URLSearchParams(window.location.search);
    const familyParam = params.get('family');
    if (familyParam) {
      const cleanId = this.api.normalizeFamilyId(familyParam);
      if (cleanId && cleanId.length >= 4) {
        this.saveFamilyConfig({ familyId: cleanId });
        if (!this.familyConfig.activePin) {
          setTimeout(() => {
            this.openPinConnectModal(`🏠 Načten Kód rodiny „${cleanId}“. Zadejte váš 8místný PIN pro připojení:`);
          }, 350);
        }
      }
    }

    await this.refreshData();
    this.notifier.startScheduler();

    // Check URL query param ?confirm=morning from notification click
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

  initAriaValidationSync() {
    const syncAria = (el) => {
      if (!el || typeof el.matches !== 'function' || !el.classList?.contains('form-input')) return;
      try {
        el.setAttribute('aria-invalid', el.matches(':user-invalid') ? 'true' : 'false');
      } catch (_) {}
    };
    document.addEventListener('blur', (e) => syncAria(e.target), true);
    document.addEventListener('input', (e) => {
      if (e.target?.hasAttribute?.('aria-invalid')) syncAria(e.target);
    });
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
      // 1. Pull latest clubs, confirmations & auth from Family Cloud if PIN is active
      await this.pullFamilySync();

      // 2. Fetch Bakaláři data (including Komens & Absence only when in Parent Mode!)
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + this.weekOffset * 7);
      this.schoolData = await this.api.fetchAllSchoolData(targetDate, this.isParentMode());
      this.renderAll();
    } catch (err) {
      this.showToast(`Chyba načítání dat: ${err.message}`, 'error');
      // Fallback to demo data if nothing is cached
      if (!this.schoolData) {
        this.schoolData = this.api.getDemoSchoolData(new Date(), this.isParentMode());
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
    this.renderParentKomensSection();
    this.renderSettingsSection();
  }

  renderHeaderStatus() {
    const studentNameEl = document.getElementById('header-student-name');
    const roleBadgeEl = document.getElementById('header-role-badge');
    const openPinBtn = document.getElementById('btn-open-pin-modal');
    const modeBadgeEl = document.getElementById('header-mode-badge');
    const pinLabelEl = document.getElementById('btn-pin-label');
    const navKomensItem = document.getElementById('nav-item-komens');
    const addClubMainBtn = document.getElementById('btn-add-club-main');
    const user = this.schoolData?.user || {};
    const isParent = this.isParentMode();

    if (studentNameEl) {
      const fullName = user.FullName || this.notifier.settings.studentName || 'Theuška';
      studentNameEl.textContent = fullName;
    }
    if (roleBadgeEl) {
      roleBadgeEl.textContent = isParent ? '👨‍👩‍👧 Rodič' : '👧 Theuška';
    }
    if (openPinBtn) {
      openPinBtn.className = `btn-role-pin-switch ${isParent ? 'role-parent' : 'role-child'}`;
    }
    if (pinLabelEl) {
      pinLabelEl.textContent = this.familyConfig.activePin ? 'Změnit' : 'PIN';
    }
    if (navKomensItem) {
      navKomensItem.hidden = !isParent;
    }
    if (addClubMainBtn) {
      addClubMainBtn.hidden = !isParent;
    }

    if (modeBadgeEl) {
      if (this.schoolData?.isDemo) {
        modeBadgeEl.title = 'Ukázkový režim (Demo ZŠ)';
        modeBadgeEl.className = 'conn-status-dot demo';
      } else if (this.schoolData?.isOfflineFallback) {
        modeBadgeEl.title = 'Offline mezipaměť';
        modeBadgeEl.className = 'conn-status-dot offline';
      } else {
        modeBadgeEl.title = 'Bakaláři API v3 aktivní';
        modeBadgeEl.className = 'conn-status-dot live';
      }
    }

    // Show/hide 1-click Notification Permission Banner on Dashboard (so Theuška can enable notifications without Parent Settings)
    const dashNotifBanner = document.getElementById('dash-notif-permission-banner');
    if (dashNotifBanner) {
      const needsPermission = 'Notification' in window && Notification.permission !== 'granted';
      dashNotifBanner.hidden = !needsPermission;
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
    const isParent = this.isParentMode();

    if (this.timetableViewMode === 'daily') {
      const schedule = this.getDayScheduleWithClubs(this.selectedDayOfWeek);
      let html = `
        <div class="timetable-day-header">
          <div>
            <h3>${schedule.dayLabel} (${schedule.dateFormatted})</h3>
            <p>${schedule.lessons.length} vyučovacích hodin • ${schedule.clubs.length} ${schedule.clubs.length === 1 ? 'odpolední kroužek' : 'odpolední kroužky'}</p>
          </div>
          ${isParent ? `
            <button type="button" class="btn-primary-sm" data-open-club-modal="${schedule.dayOfWeek}">
              + Přidat kroužek na ${schedule.dayLabel.toLowerCase()}
            </button>
          ` : ''}
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
            <p>Na ${schedule.dayLabel.toLowerCase()} zatím není naplánovaný žádný odpolední kroužek.</p>
            ${isParent ? `<button type="button" class="btn-outline-sm" data-open-club-modal="${schedule.dayOfWeek}">+ Přidat kroužek</button>` : ''}
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
              ${isParent ? `
                <div class="club-card-actions">
                  <button type="button" class="btn-icon-action" data-edit-club="${window.escapeHtml(club.id)}" title="Upravit kroužek" aria-label="Upravit kroužek">✏️</button>
                  <button type="button" class="btn-icon-action danger" data-delete-club="${window.escapeHtml(club.id)}" title="Smazat kroužek" aria-label="Smazat kroužek">🗑️</button>
                </div>
              ` : ''}
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
              ${isParent ? `<button type="button" class="btn-mini-add-club" data-open-club-modal="${d}">+ Kroužek</button>` : ''}
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
        this.pushFamilySync();
        this.renderHomeworksSection();
        this.renderDashboard();
      });
    });
  }

  toggleHomeworkDone(hwId, isDone) {
    this.hwDoneMap[hwId] = isDone;
    this.saveHwDoneMap();
    this.pushFamilySync();
    this.renderHomeworksSection();
    this.renderDashboard();
    this.showToast(isDone ? '✅ Úkol označen jako splněný!' : 'Úkol vrácen mezi rozpracované.');
  }

  /* ========================================================================
     PARENT-ONLY SECTION: KOMENS MESSAGES, NOTICEBOARD & ABSENCE
     ======================================================================== */

  /**
   * Cleans and formats Bakaláři Komens HTML messages:
   * - Decodes &nbsp; and all HTML entities (even if double-escaped)
   * - Turns runs of 4+ &nbsp;/spaces (often used by teachers instead of Enter) into line breaks
   * - Preserves <br>, <p>, <div>, <li> as clean readable paragraphs
   */
  formatKomensText(rawHtml) {
    if (!rawHtml) return '';
    let str = String(rawHtml);

    // 1. Replace block/line-break HTML tags with newline markers
    str = str
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/\s*(p|div|tr|h[1-6])\s*>/gi, '\n')
      .replace(/<\s*li[^>]*>/gi, '\n• ')
      .replace(/<\s*\/\s*li\s*>/gi, '\n');

    // 2. Strip all remaining HTML tags
    str = str.replace(/<[^>]*>/g, '');

    // 3. Decode HTML entities (&nbsp;, &amp;, &quot;, &#160;, etc.) up to 2 passes (handles double-encoded &amp;nbsp;)
    const txt = document.createElement('textarea');
    for (let i = 0; i < 2; i++) {
      txt.innerHTML = str;
      str = txt.value;
    }

    // 4. Teachers in Bakaláři often hold Spacebar (creating 5..50 &nbsp;) to push text to a new line.
    // Convert 4 or more consecutive spaces / non-breaking spaces (\u00A0) into a clean newline!
    str = str.replace(/[ \t\u00A0]{4,}/g, '\n');

    // 5. Replace remaining single non-breaking spaces (\u00A0) with normal spaces
    str = str.replace(/\u00A0/g, ' ');

    // 6. Clean up each line and remove excessive empty lines
    const lines = str
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line, idx, arr) => line !== '' || (idx > 0 && arr[idx - 1] !== ''));

    return lines
      .map((line) => (line ? `<p class="komens-p">${window.escapeHtml(line)}</p>` : ''))
      .join('');
  }

  renderParentKomensSection() {
    const receivedEl = document.getElementById('parent-komens-received-list');
    const noticeEl = document.getElementById('parent-komens-noticeboard-list');
    const absenceEl = document.getElementById('parent-absence-summary');
    const badgeEl = document.getElementById('nav-komens-badge');

    if (!this.isParentMode()) {
      if (badgeEl) badgeEl.hidden = true;
      return;
    }

    const komens = this.schoolData?.komens || { received: [], noticeboard: [] };
    const received = Array.isArray(komens.received) ? komens.received : [];
    const noticeboard = Array.isArray(komens.noticeboard) ? komens.noticeboard : [];
    const events = Array.isArray(this.schoolData?.events) ? this.schoolData.events : [];

    const unreadCount = received.filter((m) => m.Read === false || (m.CanConfirm && !m.Confirmed)).length;
    if (badgeEl) {
      badgeEl.textContent = String(unreadCount);
      badgeEl.hidden = unreadCount === 0;
    }

    if (receivedEl) {
      if (received.length === 0) {
        receivedEl.innerHTML = `<p class="empty-state-msg">Žádné přijaté zprávy v modulu Komens.</p>`;
      } else {
        receivedEl.innerHTML = received.map((msg) => {
          const msgId = msg.Id || msg.id || '';
          const senderName = msg.Sender?.Name || msg.SenderName || 'Škola / Učitel';
          const sentDate = msg.SentDate ? new Date(msg.SentDate).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
          const formattedBody = this.formatKomensText(msg.Text || '');
          const isUnread = msg.Read === false;
          const needsConfirm = Boolean(msg.CanConfirm && !msg.Confirmed);
          const isConfirmed = Boolean(msg.Confirmed);

          return `
            <article class="komens-msg-card ${isUnread || needsConfirm ? 'unread' : ''}">
              <div class="komens-msg-header">
                <strong>👩‍🏫 ${window.escapeHtml(senderName)}</strong>
                <span class="komens-date">${window.escapeHtml(sentDate)}</span>
              </div>
              <h4 class="komens-msg-title">
                ${isUnread ? `<span class="mark-new-dot">NOVÁ</span> ` : ''}
                ${needsConfirm ? `<span class="komens-confirm-badge warn">⚠️ Vyžaduje potvrzení</span> ` : ''}
                ${isConfirmed ? `<span class="komens-confirm-badge ok">✅ Potvrzeno škole</span> ` : ''}
                ${window.escapeHtml(msg.Title || 'Zpráva ze školy')}
              </h4>
              <div class="komens-msg-body">${formattedBody}</div>
              <div class="komens-msg-actions">
                ${needsConfirm ? `
                  <button type="button" class="btn-primary-sm" data-confirm-komens="${window.escapeHtml(msgId)}">
                    ✍️ Potvrdit přečtení učiteli
                  </button>
                ` : ''}
                ${isUnread && !needsConfirm ? `
                  <button type="button" class="btn-outline-sm" data-read-komens="${window.escapeHtml(msgId)}">
                    ✓ Označit jako přečtené
                  </button>
                ` : ''}
                ${!isUnread && !needsConfirm && !isConfirmed ? `
                  <span class="komens-read-label">✓ Přečteno</span>
                  <button type="button" class="btn-link-mini" data-confirm-komens="${window.escapeHtml(msgId)}" title="Odeslat potvrzení o přečtení do Bakalářů">
                    Potvrdit v Bakalářích
                  </button>
                ` : ''}
              </div>
            </article>
          `;
        }).join('');

        // Wire confirm buttons
        receivedEl.querySelectorAll('[data-confirm-komens]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-confirm-komens');
            btn.disabled = true;
            btn.textContent = 'Potvrzuji v Bakalářích...';
            try {
              await this.api.confirmKomensMessage(id);
              const target = received.find((m) => String(m.Id || m.id) === String(id));
              if (target) {
                target.Confirmed = true;
                target.Read = true;
              }
              this.api.setCached(window.BakalariPWA.STORAGE_KEYS.CACHE_KOMENS, this.schoolData.komens);
              this.renderParentKomensSection();
              this.showToast('✅ Zpráva byla potvrzena a označena jako přečtená v Bakalářích!');
            } catch (err) {
              btn.disabled = false;
              btn.textContent = '✍️ Potvrdit přečtení učiteli';
              this.showToast(`Chyba při potvrzování zprávy: ${err.message}`, 'error');
            }
          });
        });

        // Wire mark-as-read buttons
        receivedEl.querySelectorAll('[data-read-komens]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-read-komens');
            btn.disabled = true;
            btn.textContent = 'Označuji...';
            try {
              await this.api.markKomensMessageRead(id);
              const target = received.find((m) => String(m.Id || m.id) === String(id));
              if (target) {
                target.Read = true;
              }
              this.api.setCached(window.BakalariPWA.STORAGE_KEYS.CACHE_KOMENS, this.schoolData.komens);
              this.renderParentKomensSection();
              this.showToast('✓ Zpráva označena jako přečtená.');
            } catch (err) {
              btn.disabled = false;
              btn.textContent = '✓ Označit jako přečtené';
              this.showToast(`Chyba: ${err.message}`, 'error');
            }
          });
        });
      }
    }

    if (noticeEl) {
      let html = '';
      if (noticeboard.length === 0 && events.length === 0) {
        html = `<p class="empty-state-msg">Žádná aktuální sdělení na nástěnce.</p>`;
      } else {
        for (const nb of noticeboard) {
          const formattedBody = this.formatKomensText(nb.Text || '');
          html += `
            <article class="komens-msg-card notice">
              <div class="komens-msg-header">
                <strong>📌 ${window.escapeHtml(nb.Sender?.Name || 'Nástěnka školy')}</strong>
              </div>
              <h4 class="komens-msg-title">${window.escapeHtml(nb.Title || 'Oznámení')}</h4>
              <div class="komens-msg-body">${formattedBody}</div>
            </article>
          `;
        }
        for (const ev of events.slice(0, 5)) {
          const dt = ev.StartTime ? new Date(ev.StartTime).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' }) : '';
          html += `
            <article class="komens-msg-card event">
              <div class="komens-msg-header">
                <strong>🗓️ Školní akce (${window.escapeHtml(dt)})</strong>
              </div>
              <h4 class="komens-msg-title">${window.escapeHtml(ev.Title || 'Událost')}</h4>
              ${ev.Description ? `<p class="komens-msg-body">${window.escapeHtml(ev.Description)}</p>` : ''}
            </article>
          `;
        }
      }
      noticeEl.innerHTML = html;
    }

    if (absenceEl) {
      const abs = this.schoolData?.absence;
      if (!abs || (!Array.isArray(abs.Absences) && !Array.isArray(abs.AbsencesPerSubject))) {
        absenceEl.innerHTML = `<p class="empty-state-msg">Žádná zameškaná výuka v tomto pololetí.</p>`;
      } else {
        const daysList = Array.isArray(abs.Absences) ? abs.Absences : [];
        let totalMissed = 0;
        let totalUnsolved = 0;
        for (const d of daysList) {
          totalMissed += Number(d.Ok || 0) + Number(d.Missed || 0) + Number(d.Unsolved || 0);
          totalUnsolved += Number(d.Unsolved || 0);
        }

        absenceEl.innerHTML = `
          <div class="absence-stats-row">
            <div class="abs-stat-pill">Celkem zameškaných hodin: <strong>${totalMissed}</strong></div>
            <div class="abs-stat-pill ${totalUnsolved > 0 ? 'warn' : ''}">Neomluveno / k řešení: <strong>${totalUnsolved}</strong></div>
          </div>
          ${Array.isArray(abs.AbsencesPerSubject) && abs.AbsencesPerSubject.length > 0 ? `
            <div class="abs-subj-list">
              ${abs.AbsencesPerSubject.filter((s) => (s.Base || s.Excused || 0) > 0).map((s) => `
                <span class="g-chip">${window.escapeHtml(s.SubjectName)}: <strong>${s.Base || s.Excused || 0} hod.</strong></span>
              `).join('')}
            </div>
          ` : ''}
        `;
      }
    }
  }

  /* ========================================================================
     SETTINGS & BAKALÁŘI LOGIN SECTION
     ======================================================================== */

  renderSettingsSection() {
    const urlInput = document.getElementById('input-baka-url');
    const userInput = document.getElementById('input-baka-user');
    const proxyInput = document.getElementById('input-baka-proxy');
    const connStateEl = document.getElementById('baka-connection-status');

    // Family Sync inputs
    const familyIdInput = document.getElementById('family-code-id');
    const workerInput = document.getElementById('family-worker-url');
    const parentPinInput = document.getElementById('family-parent-pin');
    const childPinInput = document.getElementById('family-child-pin');
    const shareAuthInput = document.getElementById('family-share-baka-auth');
    const familyStatusPill = document.getElementById('family-sync-status-pill');

    if (familyIdInput) {
      familyIdInput.value = this.familyConfig.familyId || 'BUNDA';
    }
    if (workerInput && this.familyConfig.workerUrl) {
      workerInput.value = this.familyConfig.workerUrl;
    }
    if (parentPinInput && this.familyConfig.parentPin) {
      parentPinInput.value = this.familyConfig.parentPin;
    }
    if (childPinInput && this.familyConfig.childPin) {
      childPinInput.value = this.familyConfig.childPin;
    }
    if (shareAuthInput) {
      shareAuthInput.checked = Boolean(this.familyConfig.shareBakalariAuth);
    }
    if (familyStatusPill) {
      if (this.familyConfig.activePin && this.familyConfig.activePin.length >= 8) {
        const famLabel = this.familyConfig.familyId || 'RODINA';
        familyStatusPill.textContent = `☁️ Rodina „${famLabel}“ (${this.isParentMode() ? 'Rodič' : 'Dítě'})`;
        familyStatusPill.className = 'status-pill live';
      } else {
        familyStatusPill.textContent = 'Zatím neuloženo do cloudu';
        familyStatusPill.className = 'status-pill demo';
      }
    }

    if (urlInput && !urlInput.value && this.api.auth.schoolUrl) {
      urlInput.value = this.api.normalizeSchoolUrl(this.api.auth.schoolUrl);
    }
    if (userInput && !userInput.value) userInput.value = this.api.auth.username || '';
    if (proxyInput && !proxyInput.value) proxyInput.value = this.api.auth.proxyUrl || '';

    if (connStateEl) {
      if (this.api.isLiveMode()) {
        const accountTypeBadge = this.familyConfig.ownBakalariLogin
          ? '🔐 Vlastní přihlášení na tomto telefonu'
          : '☁️ Sdílený šifrovaný účet z rodinného cloudu (můžete se níže přihlásit i vlastním účtem)';
        connStateEl.innerHTML = `
          <div class="conn-banner live">
            <span>🟢 <strong>Připojeno k Bakalářům:</strong> ${window.escapeHtml(this.api.auth.schoolUrl)} • účet: <strong>${window.escapeHtml(this.api.auth.username)}</strong> (${accountTypeBadge})</span>
            <button type="button" class="btn-outline-sm" id="btn-logout-baka">Odpojit tento účet</button>
          </div>
        `;
        const logoutBtn = document.getElementById('btn-logout-baka');
        if (logoutBtn) {
          logoutBtn.addEventListener('click', () => {
            this.saveFamilyConfig({ ownBakalariLogin: false });
            this.api.logout();
            this.refreshData();
            this.showToast('Účet Bakalářů byl na tomto telefonu odpojen.');
          });
        }
      } else {
        connStateEl.innerHTML = `
          <div class="conn-banner demo">
            <span>🟣 <strong>Aktuálně je aktivní Ukázkový režim (Demo ZŠ).</strong> Zadejte níže přihlašovací údaje do školních Bakalářů pro načtení skutečných dat.</span>
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

    if (nameInput) nameInput.value = this.notifier.settings.studentName || 'Theuško';
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
    this.pushFamilySync();
    this.renderTimetableSection();
    this.renderDashboard();
    this.showToast('Kroužek byl odebrán z rozvrhu a synchronizován.');
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
    // Protect Parent Settings and Komens when in Child Mode (Theuška)
    if (!this.isParentMode() && (tabId === 'settings' || tabId === 'parent-komens')) {
      this.openPinConnectModal('Pro vstup do rodičovského nastavení zadejte Rodičovský PIN:');
      return;
    }

    this.activeTab = tabId;
    document.querySelectorAll('[data-nav-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-nav-tab') === tabId);
    });
    document.querySelectorAll('.app-view-section').forEach((sec) => {
      sec.hidden = sec.id !== `view-${tabId}`;
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  openPinConnectModal(customNotice = '') {
    const dialog = document.getElementById('pin-connect-dialog');
    if (!dialog) return;
    const familyIdInput = document.getElementById('pin-connect-family-id');
    const codeInput = document.getElementById('pin-connect-code');
    const workerInput = document.getElementById('pin-connect-worker');
    const errBox = document.getElementById('pin-connect-error');

    if (familyIdInput) {
      familyIdInput.value = this.familyConfig.familyId || 'BUNDA';
    }
    if (codeInput) codeInput.value = '';
    if (workerInput && this.familyConfig.workerUrl) {
      workerInput.value = this.familyConfig.workerUrl;
    }
    if (errBox) {
      if (customNotice) {
        errBox.hidden = false;
        errBox.className = 'login-result-box pending';
        errBox.textContent = customNotice;
      } else {
        errBox.hidden = true;
      }
    }
    dialog.showModal();
  }

  bindGlobalActions() {
    // Refresh data button
    const refreshBtn = document.getElementById('btn-refresh-data');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.refreshData().then(() => this.showToast('Data z Bakalářů i rodinného cloudu byla aktualizována.'));
      });
    }

    // Header PIN Connect button
    const openPinBtn = document.getElementById('btn-open-pin-modal');
    if (openPinBtn) {
      openPinBtn.addEventListener('click', () => this.openPinConnectModal());
    }

    const cancelPinBtn = document.getElementById('btn-cancel-pin-modal');
    if (cancelPinBtn) {
      cancelPinBtn.addEventListener('click', () => {
        document.getElementById('pin-connect-dialog')?.close();
      });
    }

    // Generate random Family ID button
    const genFamBtn = document.getElementById('btn-generate-family-id');
    if (genFamBtn) {
      genFamBtn.addEventListener('click', () => {
        const newId = this.generateRandomFamilyId();
        const familyIdInput = document.getElementById('family-code-id');
        if (familyIdInput) familyIdInput.value = newId;
        this.showToast(`🎲 Vygenerován nový Kód rodiny: ${newId}`);
      });
    }

    // Copy Family Invite Link button
    const copyFamLinkBtn = document.getElementById('btn-copy-family-link');
    if (copyFamLinkBtn) {
      copyFamLinkBtn.addEventListener('click', () => {
        const rawId = document.getElementById('family-code-id')?.value || this.familyConfig.familyId || 'BUNDA';
        const cleanId = this.api.normalizeFamilyId(rawId);
        if (!cleanId || cleanId.length < 4) {
          this.showToast('Zadejte nejprve platný Kód rodiny (alespoň 4 znaky).', 'error');
          return;
        }
        const shareUrl = `${window.location.origin}${window.location.pathname}?family=${encodeURIComponent(cleanId)}`;
        navigator.clipboard?.writeText(shareUrl);
        this.showToast(`📋 Odkaz pro rodinu zkopírován: ${shareUrl}`);
      });
    }

    // Submit PIN Connect Form (for Wife's phone, Daughter's phone, or switching roles)
    const pinForm = document.getElementById('pin-connect-form');
    if (pinForm) {
      pinForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const rawFamilyId = document.getElementById('pin-connect-family-id')?.value || this.familyConfig.familyId || 'BUNDA';
        const familyId = this.api.normalizeFamilyId(rawFamilyId);
        const pin = document.getElementById('pin-connect-code').value.trim();
        const workerUrl = document.getElementById('pin-connect-worker').value.trim();
        const errBox = document.getElementById('pin-connect-error');
        const submitBtn = document.getElementById('btn-submit-pin-connect');

        if (!familyId || familyId.length < 4) {
          if (errBox) {
            errBox.hidden = false;
            errBox.className = 'login-result-box error';
            errBox.textContent = '❌ Zadejte platný Kód rodiny (4–24 znaků).';
          }
          return;
        }

        if (pin.length < 8) {
          if (errBox) {
            errBox.hidden = false;
            errBox.className = 'login-result-box error';
            errBox.textContent = '❌ PIN musí obsahovat alespoň 8 znaků.';
          }
          return;
        }

        // Allow local switching if parentPin/childPin are saved locally on this device
        if (this.familyConfig.parentPin && pin === this.familyConfig.parentPin && !workerUrl) {
          this.saveFamilyConfig({ role: 'parent', familyId, activePin: pin });
          document.getElementById('pin-connect-dialog')?.close();
          await this.refreshData();
          this.showToast('👨‍👩‍👧 Přepnuto do Rodičovského režimu.');
          return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Ověřuji PIN v cloudu...';
        if (errBox) errBox.hidden = true;

        try {
          const res = await this.api.connectWithFamilyPin(workerUrl, familyId, pin);
          this.saveFamilyConfig({
            role: res.role || 'child',
            familyId,
            workerUrl,
            activePin: pin
          });
          await this.applyCloudState(res.state, res.role);
          document.getElementById('pin-connect-dialog')?.close();
          if (res.role === 'child' && (this.activeTab === 'settings' || this.activeTab === 'parent-komens')) {
            this.switchTab('dashboard');
          }
          if (res.role === 'child' && 'Notification' in window && Notification.permission === 'default') {
            this.notifier.requestPermission().then(() => this.renderHeaderStatus());
          }
          await this.refreshData();
          this.showToast(
            res.role === 'parent'
              ? `👨‍👩‍👧 Přihlášeno k rodině „${familyId}“ v Rodičovském režimu!`
              : `👧 Přihlášeno k rodině „${familyId}“ v dětském režimu!`
          );
        } catch (err) {
          // Fallback: if local parentPin / childPin match on this device for same family
          if (this.familyConfig.familyId === familyId && this.familyConfig.parentPin && pin === this.familyConfig.parentPin) {
            this.saveFamilyConfig({ role: 'parent', activePin: pin });
            document.getElementById('pin-connect-dialog')?.close();
            await this.refreshData();
            this.showToast('👨‍👩‍👧 Odemčeno lokálním Rodičovským PINem.');
          } else if (this.familyConfig.familyId === familyId && this.familyConfig.childPin && pin === this.familyConfig.childPin) {
            this.saveFamilyConfig({ role: 'child', activePin: pin });
            document.getElementById('pin-connect-dialog')?.close();
            this.switchTab('dashboard');
            await this.refreshData();
            this.showToast('👧 Přepnuto do dětského režimu.');
          } else if (errBox) {
            errBox.hidden = false;
            errBox.className = 'login-result-box error';
            errBox.textContent = `❌ ${err.message}`;
          }
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = '🔑 Ověřit PIN a připojit';
        }
      });
    }

    // Family Setup Form (Father saves Family ID, 8-char Parent PIN & Child PIN to Cloudflare Worker)
    const familySetupForm = document.getElementById('family-setup-form');
    if (familySetupForm) {
      familySetupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const rawFamilyId = document.getElementById('family-code-id')?.value || '';
        const familyId = this.api.normalizeFamilyId(rawFamilyId);
        const workerUrl = document.getElementById('family-worker-url').value.trim();
        const parentPin = document.getElementById('family-parent-pin').value.trim();
        const childPin = document.getElementById('family-child-pin').value.trim();
        const shareBakalariAuth = Boolean(document.getElementById('family-share-baka-auth')?.checked);
        const resultEl = document.getElementById('family-setup-result');
        const saveBtn = document.getElementById('btn-save-family-cloud');

        if (!familyId || familyId.length < 4) {
          this.showToast('Zadejte platný Kód rodiny (4–24 znaků).', 'error');
          return;
        }

        if (parentPin.length < 8 || childPin.length < 8) {
          this.showToast('Rodičovský i Dětský PIN musí mít alespoň 8 znaků!', 'error');
          return;
        }

        if (parentPin === childPin) {
          this.showToast('Rodičovský PIN a Dětský PIN musí být odlišné!', 'error');
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Šifruji a ukládám do Cloudflare...';

        try {
          let encryptedBakalariAuth = null;
          if (shareBakalariAuth && this.api.isLiveMode()) {
            encryptedBakalariAuth = await this.api.createEncryptedAuthBundle(
              this.api.auth,
              familyId,
              parentPin,
              childPin
            );
          }

          await this.api.setupFamilyCloud(workerUrl, familyId, parentPin, childPin, {
            currentParentPin: this.familyConfig.parentPin || parentPin,
            shareBakalariAuth,
            encryptedBakalariAuth,
            bakalariAuth: null,
            clubs: this.clubs,
            customHomeworks: this.customHomeworks,
            hwDoneMap: this.hwDoneMap,
            confirmations: this.notifier.confirmations,
            settings: this.notifier.settings
          });

          this.saveFamilyConfig({
            role: 'parent',
            familyId,
            workerUrl,
            activePin: parentPin,
            parentPin,
            childPin,
            shareBakalariAuth
          });

          const inviteLink = `${window.location.origin}${window.location.pathname}?family=${encodeURIComponent(familyId)}`;
          const authModeDesc = shareBakalariAuth
            ? '🔐 Přihlášení k Bakalářům je v cloudu <strong>End-to-End zašifrováno (AES-GCM)</strong>'
            : '🛡️ <strong>Token-less režim:</strong> Přístupové tokeny k Bakalářům se do cloudu vůbec neukládají';

          if (resultEl) {
            resultEl.hidden = false;
            resultEl.className = 'login-result-box success';
            resultEl.innerHTML = `
              ✅ <strong>Rodinná synchronizace pro rodinu „${window.escapeHtml(familyId)}“ je aktivní!</strong><br>
              • ${authModeDesc}<br>
              • Zvací odkaz pro rodinu: <code>${window.escapeHtml(inviteLink)}</code><br>
              • Na telefonu manželky zadejte Rodičovský PIN: <code>${window.escapeHtml(parentPin)}</code><br>
              • Na telefonu dcery zadejte Dětský PIN: <code>${window.escapeHtml(childPin)}</code>
            `;
          }
          this.renderSettingsSection();
          this.renderHeaderStatus();
          this.showToast(`☁️ Rodina „${familyId}“ a 8místné PINy byly uloženy!`);
        } catch (err) {
          if (resultEl) {
            resultEl.hidden = false;
            resultEl.className = 'login-result-box error';
            resultEl.textContent = `❌ ${err.message} (Ujistěte se, že jste do Cloudflare Workeru nasadil novou verzi cloudflare-worker-proxy.js).`;
          }
          this.showToast(err.message, 'error');
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = '☁️ Uložit rodinný profil a aktivovat 8místné PINy';
        }
      });
    }

    // Quick switch to Child Mode button
    const switchChildBtn = document.getElementById('btn-switch-to-child-preview');
    if (switchChildBtn) {
      switchChildBtn.addEventListener('click', () => {
        const childPin = document.getElementById('family-child-pin')?.value.trim() || this.familyConfig.childPin || '';
        const parentPin = document.getElementById('family-parent-pin')?.value.trim() || this.familyConfig.parentPin || '';
        if (childPin.length < 8 || parentPin.length < 8) {
          this.showToast('Nejprve prosím nastavte alespoň 8místný Rodičovský a Dětský PIN.', 'error');
          return;
        }
        this.saveFamilyConfig({
          role: 'child',
          activePin: childPin,
          parentPin,
          childPin
        });
        this.switchTab('dashboard');
        this.renderAll();
        this.showToast(`👧 Přepnuto do dětského režimu! Pro návrat do rodičovského režimu klikněte nahoře na „🔑 Změnit“ a zadejte Rodičovský PIN.`);
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
        this.pushFamilySync();
        this.selectedDayOfWeek = newClub.dayOfWeek;
        document.getElementById('club-editor-dialog').close();
        this.renderTimetableSection();
        this.renderDashboard();
        this.showToast(`Kroužek „${newClub.name}“ byl uložen a synchronizován pro Theušku!`);
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
        this.pushFamilySync();
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

    // Wire up live diagnostic logger from API client
    const diagLogEl = document.getElementById('baka-diagnostic-log');
    const resultBoxEl = document.getElementById('baka-login-result-box');

    this.api.onLogUpdate = (logs) => {
      if (!diagLogEl) return;
      if (!logs || logs.length === 0) {
        diagLogEl.textContent = 'Spouštím diagnostiku připojení...';
        return;
      }
      diagLogEl.textContent = logs
        .map((l) => `[${l.time}] ${l.type === 'error' ? '❌' : l.type === 'warn' ? '⚠️' : l.type === 'success' ? '✅' : 'ℹ️'} ${l.message}`)
        .join('\n');
      diagLogEl.scrollTop = diagLogEl.scrollHeight;
    };

    const copyLogBtn = document.getElementById('btn-copy-diag-log');
    if (copyLogBtn && diagLogEl) {
      copyLogBtn.addEventListener('click', () => {
        navigator.clipboard?.writeText(diagLogEl.textContent || '');
        this.showToast('📋 Diagnostický výpis byl zkopírován do schránky.');
      });
    }

    // Bakaláři Login Form
    const loginForm = document.getElementById('bakalari-login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const urlInput = document.getElementById('input-baka-url');
        const url = urlInput.value;
        const user = document.getElementById('input-baka-user').value;
        const pass = document.getElementById('input-baka-pass').value;
        const proxy = document.getElementById('input-baka-proxy').value;
        const submitBtn = document.getElementById('btn-submit-baka-login');

        // Auto-normalize URL visibly in the input box (e.g. /5010 -> :5010)
        const normalized = this.api.normalizeSchoolUrl(url);
        if (normalized) urlInput.value = normalized;

        if (resultBoxEl) {
          resultBoxEl.hidden = false;
          resultBoxEl.className = 'login-result-box pending';
          resultBoxEl.textContent = '⏳ Probíhá přihlašování a ověřování komunikace se školou... Sledujte výpis níže.';
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Přihlašuji k Bakalářům...';

        try {
          await this.api.login(url, user, pass, proxy);
          this.saveFamilyConfig({ ownBakalariLogin: true });
          document.getElementById('input-baka-pass').value = '';
          await this.refreshData();
          if (this.familyConfig.shareBakalariAuth) {
            this.pushFamilySync(true);
          }
          if (resultBoxEl) {
            resultBoxEl.hidden = false;
            resultBoxEl.className = 'login-result-box success';
            resultBoxEl.textContent = `✅ Úspěšně připojeno pod účtem ${this.api.auth.username} (${this.api.auth.schoolUrl})! Tento telefon nyní čte a potvrzuje zprávy Komens pod tímto účtem a zároveň zůstává v rodinné synchronizaci.`;
          }
          this.showToast(`✅ Připojeno k Bakalářům pod účtem ${this.api.auth.username}!`);
        } catch (err) {
          if (resultBoxEl) {
            resultBoxEl.hidden = false;
            resultBoxEl.className = 'login-result-box error';
            resultBoxEl.textContent = `❌ Chyba přihlášení: ${err.message}`;
          }
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
          studentName: document.getElementById('setting-student-name').value.trim() || 'Theuško',
          morningTime: document.getElementById('setting-morning-time').value || '07:00',
          homeworkTime: document.getElementById('setting-homework-time').value || '17:00',
          eveningTime: document.getElementById('setting-evening-time').value || '19:30',
          soundEnabled: document.getElementById('setting-sound-enabled').checked,
          requireChecklistTicks: document.getElementById('setting-require-ticks').checked
        });
        this.pushFamilySync();
        this.renderAll();
        this.showToast('⚙️ Nastavení časů upozornění bylo uloženo!');
      });
    }

    // Request Browser Notification Permission button (Settings & Dashboard Banner)
    const handleReqPermission = async () => {
      const res = await this.notifier.requestPermission();
      this.updateNotificationPermissionBadge();
      this.renderHeaderStatus();
      if (res === 'granted') {
        this.showToast('🔔 Systémové vyskakovací notifikace byly povoleny!');
      } else {
        this.showToast('Notifikace nebyly povoleny v prohlížeči, vyskakovací okna v aplikaci však fungují vždy.', 'error');
      }
    };

    const reqPermBtn = document.getElementById('btn-request-notif-permission');
    if (reqPermBtn) {
      reqPermBtn.addEventListener('click', handleReqPermission);
    }

    const dashEnableNotifsBtn = document.getElementById('btn-dash-enable-notifs');
    if (dashEnableNotifsBtn) {
      dashEnableNotifsBtn.addEventListener('click', handleReqPermission);
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

