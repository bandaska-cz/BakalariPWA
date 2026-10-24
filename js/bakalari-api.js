/* ==========================================================================
   BAKALÁŘI API v3 CLIENT & GRADE PREDICTION ENGINE
   Specifikace: https://github.com/bakalari-api/bakalari-api-v3
   ========================================================================== */

const STORAGE_KEYS = {
  AUTH: 'bakalari_pwa_auth_v1',
  CACHE_USER: 'bakalari_pwa_user_v1',
  CACHE_TIMETABLE: 'bakalari_pwa_timetable_v1',
  CACHE_MARKS: 'bakalari_pwa_marks_v1',
  CACHE_HOMEWORKS: 'bakalari_pwa_homeworks_v1',
  CUSTOM_CLUBS: 'bakalari_pwa_clubs_v1',
  CUSTOM_HOMEWORKS: 'bakalari_pwa_custom_hw_v1',
  HW_DONE_MAP: 'bakalari_pwa_hw_done_v1',
  SETTINGS: 'bakalari_pwa_settings_v1',
  CONFIRMATIONS: 'bakalari_pwa_confirmations_v1'
};

class BakalariApiClient {
  constructor() {
    this.auth = this.loadAuth();
  }

  loadAuth() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.AUTH);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.error('Chyba při čtení přihlášení:', e);
    }
    return {
      mode: 'demo', // 'demo' | 'live'
      schoolUrl: '',
      proxyUrl: '',
      username: '',
      accessToken: '',
      refreshToken: '',
      expiresAt: 0
    };
  }

  saveAuth(authData) {
    this.auth = { ...this.auth, ...authData };
    localStorage.setItem(STORAGE_KEYS.AUTH, JSON.stringify(this.auth));
  }

  logout() {
    this.auth = {
      mode: 'demo',
      schoolUrl: this.auth.schoolUrl || '',
      proxyUrl: this.auth.proxyUrl || '',
      username: '',
      accessToken: '',
      refreshToken: '',
      expiresAt: 0
    };
    localStorage.setItem(STORAGE_KEYS.AUTH, JSON.stringify(this.auth));
  }

  isLiveMode() {
    return this.auth.mode === 'live' && Boolean(this.auth.schoolUrl && this.auth.accessToken);
  }

  /**
   * Normalizes school URL so users can enter e.g.
   * "https://bakalari.zs-priklad.cz" or "https://zs-priklad.cz/bakaweb/login"
   */
  normalizeSchoolUrl(rawUrl) {
    let url = (rawUrl || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    url = url.replace(/\/+$/, '');
    url = url.replace(/\/dashboard(\/.*)?$/i, '');
    url = url.replace(/\/next(\/.*)?$/i, '');
    url = url.replace(/\/api\/3(\/.*)?$/i, '');
    url = url.replace(/\/api(\/.*)?$/i, '');
    url = url.replace(/\/login$/i, '');
    return url;
  }

  buildEndpointUrl(baseUrl, path, proxyUrl) {
    const cleanBase = baseUrl.replace(/\/+$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const targetUrl = `${cleanBase}${cleanPath}`;

    const cleanProxy = (proxyUrl || '').trim();
    if (!cleanProxy) return targetUrl;

    if (cleanProxy.includes('{url}')) {
      return cleanProxy.replace('{url}', encodeURIComponent(targetUrl));
    }
    if (cleanProxy.endsWith('=') || cleanProxy.endsWith('?')) {
      return `${cleanProxy}${encodeURIComponent(targetUrl)}`;
    }
    if (cleanProxy.includes('workers.dev')) {
      return `${cleanProxy.replace(/\/+$/, '')}?url=${encodeURIComponent(targetUrl)}`;
    }
    return `${cleanProxy.replace(/\/+$/, '')}/proxy?url=${encodeURIComponent(targetUrl)}`;
  }

  /**
   * Authenticate against Bakaláři API (/api/login or /api/3/login)
   * POST Content-Type: application/x-www-form-urlencoded
   * Body: client_id=ANDR&grant_type=password&username=...&password=...
   */
  async login(schoolUrl, username, password, proxyUrl = '') {
    let normalizedUrl = this.normalizeSchoolUrl(schoolUrl);
    if (!normalizedUrl) {
      throw new Error('Zadejte prosím platnou URL adresu školních Bakalářů.');
    }

    const bodyParams = new URLSearchParams({
      client_id: 'ANDR',
      grant_type: 'password',
      username: username.trim(),
      password: password
    });

    const candidatePaths = ['/api/login', '/api/3/login'];
    const candidateBases = [normalizedUrl];
    if (!normalizedUrl.toLowerCase().endsWith('/bakaweb')) {
      candidateBases.push(`${normalizedUrl}/bakaweb`);
    }

    let lastResult = null;
    let lastError = null;

    for (const base of candidateBases) {
      for (const p of candidatePaths) {
        try {
          const endpoint = this.buildEndpointUrl(base, p, proxyUrl);
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json'
            },
            body: bodyParams.toString()
          });

          // Check if response is valid JSON
          const contentType = response.headers.get('content-type') || '';
          const text = await response.text();
          let data = null;
          try {
            data = JSON.parse(text);
          } catch (_) {}

          if (data && (response.ok || data.error || data.error_description)) {
            lastResult = { response, data, base, loginPath: p };
            break;
          }
        } catch (e) {
          lastError = e;
        }
      }
      if (lastResult) break;
    }

    if (!lastResult) {
      throw new Error(
        'Nepodařilo se spojit s API Bakalářů. Zkontrolujte prosím adresu školy a Cloudflare Worker proxy.' +
        (lastError ? ` (${lastError.message})` : '')
      );
    }

    const { response, data, base, loginPath } = lastResult;

    if (!response.ok || !data.access_token) {
      const errDesc = data.error_description || data.error || `Chyba přihlášení (HTTP ${response.status})`;
      throw new Error(errDesc);
    }

    const expiresInSec = Number(data.expires_in) || 3600;
    this.saveAuth({
      mode: 'live',
      schoolUrl: base,
      loginPath: loginPath || '/api/login',
      proxyUrl: proxyUrl.trim(),
      username: username.trim(),
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      expiresAt: Date.now() + (expiresInSec - 60) * 1000
    });

    return data;
  }

  /**
   * Refresh token via POST /api/login or /api/3/login
   * Body: client_id=ANDR&grant_type=refresh_token&refresh_token=...
   */
  async refreshAccessToken() {
    if (!this.auth.refreshToken || !this.auth.schoolUrl) {
      throw new Error('Chybí refresh token pro obnovení relace.');
    }

    const bodyParams = new URLSearchParams({
      client_id: 'ANDR',
      grant_type: 'refresh_token',
      refresh_token: this.auth.refreshToken
    });

    const loginPath = this.auth.loginPath || '/api/login';
    const endpoint = this.buildEndpointUrl(this.auth.schoolUrl, loginPath, this.auth.proxyUrl);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: bodyParams.toString()
    });

    if (!response.ok) {
      throw new Error('Obnovení přihlášení selhalo, přihlaste se prosím znovu.');
    }

    const data = await response.json();
    const expiresInSec = Number(data.expires_in) || 3600;
    this.saveAuth({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.auth.refreshToken,
      expiresAt: Date.now() + (expiresInSec - 60) * 1000
    });
    return data.access_token;
  }

  /**
   * Perform authorized GET/PUT request to Bakaláři API v3
   */
  async apiRequest(path, options = {}) {
    if (Date.now() >= this.auth.expiresAt && this.auth.refreshToken) {
      try {
        await this.refreshAccessToken();
      } catch (e) {
        console.warn('Auto-refresh tokenu selhal:', e);
      }
    }

    const doFetch = async (token) => {
      const url = this.buildEndpointUrl(this.auth.schoolUrl, path, this.auth.proxyUrl);
      return fetch(url, {
        ...options,
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
          ...(options.headers || {})
        }
      });
    };

    let response = await doFetch(this.auth.accessToken);
    if (response.status === 401 && this.auth.refreshToken) {
      const newToken = await this.refreshAccessToken();
      response = await doFetch(newToken);
    }

    if (!response.ok) {
      throw new Error(`Bakaláři API chyba: HTTP ${response.status} na ${path}`);
    }

    return response.json();
  }

  /* ========================================================================
     HIGH-LEVEL DATA METHODS (Live API + Offline Cache + Demo Mode)
     ======================================================================== */

  async fetchAllSchoolData(targetDate = new Date()) {
    const dateIso = formatDateIso(targetDate);

    if (this.isLiveMode()) {
      try {
        const [user, timetable, marks, homeworks] = await Promise.all([
          this.apiRequest('/api/3/user').catch(() => this.getCached(STORAGE_KEYS.CACHE_USER)),
          this.apiRequest(`/api/3/timetable/actual?date=${dateIso}`),
          this.apiRequest('/api/3/marks'),
          this.apiRequest('/api/3/homeworks')
        ]);

        if (user) this.setCached(STORAGE_KEYS.CACHE_USER, user);
        if (timetable) this.setCached(STORAGE_KEYS.CACHE_TIMETABLE, timetable);
        if (marks) this.setCached(STORAGE_KEYS.CACHE_MARKS, marks);
        if (homeworks) this.setCached(STORAGE_KEYS.CACHE_HOMEWORKS, homeworks);

        return {
          isDemo: false,
          isOfflineFallback: false,
          user: user || { FullName: this.auth.username, Class: { Abbrev: 'ZŠ' }, SchoolOrganizationName: 'Základní škola' },
          timetable,
          marks,
          homeworks
        };
      } catch (err) {
        console.warn('Nepodařilo se načíst živá data z Bakalářů, používám offline mezipaměť:', err);
        const cachedTimetable = this.getCached(STORAGE_KEYS.CACHE_TIMETABLE);
        const cachedMarks = this.getCached(STORAGE_KEYS.CACHE_MARKS);
        const cachedHomeworks = this.getCached(STORAGE_KEYS.CACHE_HOMEWORKS);
        if (cachedTimetable && cachedMarks) {
          return {
            isDemo: false,
            isOfflineFallback: true,
            errorMsg: err.message,
            user: this.getCached(STORAGE_KEYS.CACHE_USER) || { FullName: this.auth.username },
            timetable: cachedTimetable,
            marks: cachedMarks,
            homeworks: cachedHomeworks || { Homeworks: [] }
          };
        }
        throw err;
      }
    }

    // Demo Mode: realistic Czech elementary school dataset anchored to targetDate's week
    return this.getDemoSchoolData(targetDate);
  }

  async fetchTimetableForDate(targetDate) {
    const dateIso = formatDateIso(targetDate);
    if (this.isLiveMode()) {
      const tt = await this.apiRequest(`/api/3/timetable/actual?date=${dateIso}`);
      return tt;
    }
    return this.getDemoSchoolData(targetDate).timetable;
  }

  getCached(key) {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : null;
    } catch (_) {
      return null;
    }
  }

  setCached(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (_) {}
  }

  /* ========================================================================
     DEMO DATA GENERATOR (Realistic Bakaláři API v3 structures for ZŠ)
     ======================================================================== */
  getDemoSchoolData(referenceDate = new Date()) {
    const monday = getMondayOfWeek(referenceDate);
    const today = new Date();
    const tomorrow = getNextSchoolDay(today);

    const hours = [
      { Id: 1, Caption: '1', BeginTime: '8:00', EndTime: '8:45' },
      { Id: 2, Caption: '2', BeginTime: '8:55', EndTime: '9:40' },
      { Id: 3, Caption: '3', BeginTime: '10:00', EndTime: '10:45' },
      { Id: 4, Caption: '4', BeginTime: '10:55', EndTime: '11:40' },
      { Id: 5, Caption: '5', BeginTime: '11:50', EndTime: '12:35' },
      { Id: 6, Caption: '6', BeginTime: '12:45', EndTime: '13:30' },
      { Id: 7, Caption: '7', BeginTime: '13:40', EndTime: '14:25' }
    ];

    const subjects = [
      { Id: 'SUB_CJ', Abbrev: 'Čj', Name: 'Český jazyk a literatura' },
      { Id: 'SUB_M', Abbrev: 'M', Name: 'Matematika' },
      { Id: 'SUB_AJ', Abbrev: 'Aj', Name: 'Anglický jazyk' },
      { Id: 'SUB_PR', Abbrev: 'Př', Name: 'Přírodopis' },
      { Id: 'SUB_VL', Abbrev: 'D', Name: 'Dějepis' },
      { Id: 'SUB_Z', Abbrev: 'Z', Name: 'Zeměpis' },
      { Id: 'SUB_HV', Abbrev: 'Hv', Name: 'Hudební výchova' },
      { Id: 'SUB_VV', Abbrev: 'Vv', Name: 'Výtvarná výchova' },
      { Id: 'SUB_TV', Abbrev: 'Tv', Name: 'Tělesná výchova' },
      { Id: 'SUB_INF', Abbrev: 'Inf', Name: 'Informatika' },
      { Id: 'SUB_PČ', Abbrev: 'Pč', Name: 'Pracovní činnosti' }
    ];

    const teachers = [
      { Id: 'T1', Abbrev: 'Nov', Name: 'Mgr. Jana Nováková' },
      { Id: 'T2', Abbrev: 'Svo', Name: 'Mgr. Petr Svoboda' },
      { Id: 'T3', Abbrev: 'Dvo', Name: 'Mgr. Lucie Dvořáková' },
      { Id: 'T4', Abbrev: 'Kuč', Name: 'Mgr. Tomáš Kučera' },
      { Id: 'T5', Abbrev: 'Pro', Name: 'Mgr. Eva Procházková' },
      { Id: 'T6', Abbrev: 'Mal', Name: 'Bc. Martin Malý' }
    ];

    const rooms = [
      { Id: 'R_6A', Abbrev: '6.A', Name: 'Kmenová učebna 6.A' },
      { Id: 'R_AJ', Abbrev: 'J1', Name: 'Jazyková učebna 1' },
      { Id: 'R_PR', Abbrev: 'Př', Name: 'Učebna přírodopisu' },
      { Id: 'R_INF', Abbrev: 'PC', Name: 'Počítačová učebna' },
      { Id: 'R_TV', Abbrev: 'Těl', Name: 'Velká tělocvična' },
      { Id: 'R_VV', Abbrev: 'At', Name: 'Výtvarný ateliér' },
      { Id: 'R_HV', Abbrev: 'Hv', Name: 'Hudebna' }
    ];

    // Weekly schedule template (Mon - Fri)
    const weeklyPlan = [
      // 1 = Pondělí
      [
        { HourId: 1, SubjectId: 'SUB_CJ', TeacherId: 'T1', RoomId: 'R_6A', Theme: 'Stavba slova – předpony a přípony' },
        { HourId: 2, SubjectId: 'SUB_M', TeacherId: 'T2', RoomId: 'R_6A', Theme: 'Desetinná čísla – zaokrouhlování' },
        { HourId: 3, SubjectId: 'SUB_AJ', TeacherId: 'T3', RoomId: 'R_AJ', Theme: 'Present Continuous – rozhovory' },
        { HourId: 4, SubjectId: 'SUB_PR', TeacherId: 'T4', RoomId: 'R_PR', Theme: 'Stavba rostlinné buňky – mikroskopování' },
        { HourId: 5, SubjectId: 'SUB_TV', TeacherId: 'T6', RoomId: 'R_TV', Theme: 'Přehazovaná a opičí dráha' }
      ],
      // 2 = Úterý
      [
        { HourId: 1, SubjectId: 'SUB_M', TeacherId: 'T2', RoomId: 'R_6A', Theme: 'Sčítání a odčítání desetinných čísel' },
        { HourId: 2, SubjectId: 'SUB_CJ', TeacherId: 'T1', RoomId: 'R_6A', Theme: 'Čtenářská dílna – dobrodružná próza' },
        { HourId: 3, SubjectId: 'SUB_Z', TeacherId: 'T4', RoomId: 'R_6A', Theme: 'Planeta Země – střídání ročních období' },
        { HourId: 4, SubjectId: 'SUB_AJ', TeacherId: 'T3', RoomId: 'R_AJ', Theme: 'My Daily Routine – slovní zásoba' },
        { HourId: 5, SubjectId: 'SUB_HV', TeacherId: 'T5', RoomId: 'R_HV', Theme: 'Lidové písně a rytmické nástroje' },
        { HourId: 6, SubjectId: 'SUB_INF', TeacherId: 'T6', RoomId: 'R_INF', Theme: 'Blokové programování a algoritmy' }
      ],
      // 3 = Středa
      [
        { HourId: 1, SubjectId: 'SUB_CJ', TeacherId: 'T1', RoomId: 'R_6A', Theme: 'Vyjmenovaná slova – souhrnný diktát' },
        { HourId: 2, SubjectId: 'SUB_M', TeacherId: 'T2', RoomId: 'R_6A', Theme: 'Geometrie – úhly a jejich měření úhloměrem' },
        { HourId: 3, SubjectId: 'SUB_VL', TeacherId: 'T5', RoomId: 'R_6A', Theme: 'Pravěk – lovci mamutů a první zemědělci' },
        {
          HourId: 4,
          SubjectId: 'SUB_PR',
          TeacherId: 'T1',
          RoomId: 'R_6A',
          Theme: 'Suplovaná hodina – opakování přírodopisu',
          Change: {
            ChangeType: 'Replaced',
            Description: 'Suplování za Mgr. Kučeru (Mgr. Nováková)',
            Time: '10:55 - 11:40'
          }
        },
        { HourId: 5, SubjectId: 'SUB_PČ', TeacherId: 'T5', RoomId: 'R_VV', Theme: 'Podzimní dekorace z přírodnin' }
      ],
      // 4 = Čtvrtek
      [
        { HourId: 1, SubjectId: 'SUB_AJ', TeacherId: 'T3', RoomId: 'R_AJ', Theme: 'Poslech a čtení s porozuměním' },
        { HourId: 2, SubjectId: 'SUB_M', TeacherId: 'T2', RoomId: 'R_6A', Theme: 'Slovní úlohy s desetinnými čísly' },
        { HourId: 3, SubjectId: 'SUB_CJ', TeacherId: 'T1', RoomId: 'R_6A', Theme: 'Sloh – vypravování podle obrázkové osnovy' },
        { HourId: 4, SubjectId: 'SUB_Z', TeacherId: 'T4', RoomId: 'R_6A', Theme: 'Práce s atlasem a měřítko mapy' },
        { HourId: 5, SubjectId: 'SUB_TV', TeacherId: 'T6', RoomId: 'R_TV', Theme: 'Florbal – přihrávky a střelba na branku' }
      ],
      // 5 = Pátek
      [
        { HourId: 1, SubjectId: 'SUB_CJ', TeacherId: 'T1', RoomId: 'R_6A', Theme: 'Slovní druhy – podstatná jména' },
        { HourId: 2, SubjectId: 'SUB_M', TeacherId: 'T2', RoomId: 'R_6A', Theme: 'Pětiminutovka a početní hry' },
        { HourId: 3, SubjectId: 'SUB_VL', TeacherId: 'T5', RoomId: 'R_6A', Theme: 'Starověký Egypt – pyramidy a hieroglyfy' },
        { HourId: 4, SubjectId: 'SUB_VV', TeacherId: 'T5', RoomId: 'R_VV', Theme: 'Malba temperou – barevný podzim' },
        { HourId: 5, SubjectId: 'SUB_VV', TeacherId: 'T5', RoomId: 'R_VV', Theme: 'Dokončení malby a společná výstavka' }
      ]
    ];

    const days = weeklyPlan.map((atoms, idx) => {
      const dayDate = new Date(monday);
      dayDate.setDate(monday.getDate() + idx);
      return {
        Date: formatDateIso(dayDate) + 'T00:00:00+02:00',
        DayOfWeek: idx + 1,
        DayType: 'WorkDay',
        DayDescription: '',
        Atoms: atoms
      };
    });

    const tomorrowIso = formatDateIso(tomorrow);
    const twoDaysLater = new Date(tomorrow);
    twoDaysLater.setDate(tomorrow.getDate() + 1);
    const twoDaysIso = formatDateIso(twoDaysLater);
    const threeDaysLater = new Date(tomorrow);
    threeDaysLater.setDate(tomorrow.getDate() + 2);
    const threeDaysIso = formatDateIso(threeDaysLater);

    const marksData = {
      Subjects: [
        {
          Subject: { Id: 'SUB_CJ', Abbrev: 'Čj', Name: 'Český jazyk a literatura' },
          AverageText: '1,38',
          CalculateAverage: true,
          Marks: [
            { Id: 'M_CJ_1', MarkText: '1', Weight: 5, Date: '2026-09-14T00:00:00', Caption: 'Pravopisné cvičení', Theme: 'Vyjmenovaná slova', IsNew: false },
            { Id: 'M_CJ_2', MarkText: '2', Weight: 8, Date: '2026-09-29T00:00:00', Caption: 'Čtvrtletní diktát', Theme: 'Shoda přísudku s podmětem', IsNew: false },
            { Id: 'M_CJ_3', MarkText: '1', Weight: 6, Date: '2026-10-10T00:00:00', Caption: 'Čtenářský deník', Theme: 'Prezentace přečtené knihy', IsNew: false },
            { Id: 'M_CJ_4', MarkText: '1', Weight: 5, Date: '2026-10-20T00:00:00', Caption: 'Stavba slova – testík', Theme: 'Kořen, předpona, přípona', IsNew: true }
          ]
        },
        {
          Subject: { Id: 'SUB_M', Abbrev: 'M', Name: 'Matematika' },
          AverageText: '1,59',
          CalculateAverage: true,
          Marks: [
            { Id: 'M_MA_1', MarkText: '1', Weight: 4, Date: '2026-09-11T00:00:00', Caption: 'Pětiminutovka', Theme: 'Násobilka a dělení', IsNew: false },
            { Id: 'M_MA_2', MarkText: '2', Weight: 10, Date: '2026-09-25T00:00:00', Caption: 'Velká písemná práce', Theme: 'Přirozená čísla a slovní úlohy', IsNew: false },
            { Id: 'M_MA_3', MarkText: '1-', Weight: 5, Date: '2026-10-08T00:00:00', Caption: 'Geometrie – rýsování', Theme: 'Trojúhelníky a úhly', IsNew: false },
            { Id: 'M_MA_4', MarkText: '1', Weight: 3, Date: '2026-10-19T00:00:00', Caption: 'Aktivita v hodině', Theme: 'Desetinná čísla', IsNew: true }
          ]
        },
        {
          Subject: { Id: 'SUB_AJ', Abbrev: 'Aj', Name: 'Anglický jazyk' },
          AverageText: '1,14',
          CalculateAverage: true,
          Marks: [
            { Id: 'M_AJ_1', MarkText: '1', Weight: 5, Date: '2026-09-16T00:00:00', Caption: 'Slovíčka Unit 1', Theme: 'Family and Friends', IsNew: false },
            { Id: 'M_AJ_2', MarkText: '1', Weight: 8, Date: '2026-10-02T00:00:00', Caption: 'Unit 1 Test', Theme: 'Present Simple & Vocabulary', IsNew: false },
            { Id: 'M_AJ_3', MarkText: '1-', Weight: 4, Date: '2026-10-18T00:00:00', Caption: 'Rozhovor ve dvojici', Theme: 'My Daily Routine', IsNew: false }
          ]
        },
        {
          Subject: { Id: 'SUB_PR', Abbrev: 'Př', Name: 'Přírodopis' },
          AverageText: '1,31',
          CalculateAverage: true,
          Marks: [
            { Id: 'M_PR_1', MarkText: '1', Weight: 6, Date: '2026-09-22T00:00:00', Caption: 'Laboratorní práce', Theme: 'Pozorování pod lupou a mikroskopem', IsNew: false },
            { Id: 'M_PR_2', MarkText: '2', Weight: 4, Date: '2026-10-06T00:00:00', Caption: 'Opakovací testík', Theme: 'Vznik a podmínky života na Zemi', IsNew: false },
            { Id: 'M_PR_3', MarkText: '1', Weight: 3, Date: '2026-10-21T00:00:00', Caption: 'Nákres buňky v sešitě', Theme: 'Rostlinná a živočišná buňka', IsNew: true }
          ]
        },
        {
          Subject: { Id: 'SUB_VL', Abbrev: 'D', Name: 'Dějepis' },
          AverageText: '1,00',
          CalculateAverage: true,
          Marks: [
            { Id: 'M_VL_1', MarkText: '1', Weight: 5, Date: '2026-09-24T00:00:00', Caption: 'Časová osa', Theme: 'Jak měříme čas v historii', IsNew: false },
            { Id: 'M_VL_2', MarkText: '1', Weight: 7, Date: '2026-10-15T00:00:00', Caption: 'Projekt – Pravěk', Theme: 'Život lovců mamutů', IsNew: false }
          ]
        },
        {
          Subject: { Id: 'SUB_Z', Abbrev: 'Z', Name: 'Zeměpis' },
          AverageText: '1,64',
          CalculateAverage: true,
          Marks: [
            { Id: 'M_ZE_1', MarkText: '2', Weight: 7, Date: '2026-09-30T00:00:00', Caption: 'Test – Vesmír a Sluneční soustava', Theme: 'Planety a pohyby Země', IsNew: false },
            { Id: 'M_ZE_2', MarkText: '1', Weight: 4, Date: '2026-10-14T00:00:00', Caption: 'Slepá mapa', Theme: 'Kontinenty a oceány', IsNew: false }
          ]
        },
        {
          Subject: { Id: 'SUB_INF', Abbrev: 'Inf', Name: 'Informatika' },
          AverageText: '1,00',
          CalculateAverage: true,
          Marks: [
            { Id: 'M_IN_1', MarkText: '1', Weight: 6, Date: '2026-10-05T00:00:00', Caption: 'Miniprojekt ve Scratchi', Theme: 'Cyklus a podmínka v programu', IsNew: false }
          ]
        },
        {
          Subject: { Id: 'SUB_HV', Abbrev: 'Hv', Name: 'Hudební výchova' },
          AverageText: '1,00',
          CalculateAverage: true,
          Marks: [
            { Id: 'M_HV_1', MarkText: '1', Weight: 3, Date: '2026-09-28T00:00:00', Caption: 'Zpěv a rytmizace', Theme: 'Notová osnova', IsNew: false }
          ]
        },
        {
          Subject: { Id: 'SUB_VV', Abbrev: 'Vv', Name: 'Výtvarná výchova' },
          AverageText: '1,00',
          CalculateAverage: true,
          Marks: [
            { Id: 'M_VV_1', MarkText: '1', Weight: 4, Date: '2026-10-09T00:00:00', Caption: 'Podzimní koláž', Theme: 'Kombinovaná technika', IsNew: false }
          ]
        },
        {
          Subject: { Id: 'SUB_TV', Abbrev: 'Tv', Name: 'Tělesná výchova' },
          AverageText: '1,00',
          CalculateAverage: true,
          Marks: [
            { Id: 'M_TV_1', MarkText: '1', Weight: 4, Date: '2026-09-21T00:00:00', Caption: 'Atletický čtyřboj', Theme: 'Běh na 60 m a skok daleký', IsNew: false }
          ]
        }
      ]
    };

    const homeworksData = {
      Homeworks: [
        {
          Id: 'HW_DEMO_1',
          DateStart: formatDateIso(today) + 'T08:00:00+02:00',
          DateEnd: tomorrowIso + 'T08:00:00+02:00',
          Content: 'Pracovní sešit str. 18 / cv. 3 a 4 – zaokrouhlování desetinných čísel na desetiny a setiny. Nezapomeň vzít úhloměr a kružítko!',
          Subject: { Id: 'SUB_M', Abbrev: 'M', Name: 'Matematika' },
          Teacher: { Id: 'T2', Abbrev: 'Svo', Name: 'Mgr. Petr Svoboda' },
          Done: false,
          Closed: false
        },
        {
          Id: 'HW_DEMO_2',
          DateStart: formatDateIso(today) + 'T10:00:00+02:00',
          DateEnd: tomorrowIso + 'T08:00:00+02:00',
          Content: 'Zopakovat si 12 nových slovíček z lekce 2B (My Daily Routine) + v pracovním sešitě str. 14 doplnit křížovku.',
          Subject: { Id: 'SUB_AJ', Abbrev: 'Aj', Name: 'Anglický jazyk' },
          Teacher: { Id: 'T3', Abbrev: 'Dvo', Name: 'Mgr. Lucie Dvořáková' },
          Done: false,
          Closed: false
        },
        {
          Id: 'HW_DEMO_3',
          DateStart: formatDateIso(today) + 'T09:00:00+02:00',
          DateEnd: twoDaysIso + 'T08:00:00+02:00',
          Content: 'Napsat krátké vypravování (cca 10 vět) do slohového sešitu na téma „Můj nejlepší zážitek z podzimu“.',
          Subject: { Id: 'SUB_CJ', Abbrev: 'Čj', Name: 'Český jazyk a literatura' },
          Teacher: { Id: 'T1', Abbrev: 'Nov', Name: 'Mgr. Jana Nováková' },
          Done: false,
          Closed: false
        },
        {
          Id: 'HW_DEMO_4',
          DateStart: formatDateIso(today) + 'T11:00:00+02:00',
          DateEnd: threeDaysIso + 'T08:00:00+02:00',
          Content: 'Přinést vylisované podzimní listy (alespoň 4 druhy stromů) a čtvrtku A4 na přírodopis a výtvarku.',
          Subject: { Id: 'SUB_PR', Abbrev: 'Př', Name: 'Přírodopis' },
          Teacher: { Id: 'T4', Abbrev: 'Kuč', Name: 'Mgr. Tomáš Kučera' },
          Done: true,
          Closed: false
        }
      ]
    };

    return {
      isDemo: true,
      isOfflineFallback: false,
      user: {
        FullName: 'Eliška (6.A)',
        UserType: 'student',
        Class: { Id: '6A', Abbrev: '6.A', Name: '6. A' },
        SchoolOrganizationName: 'Základní škola (Ukázkový režim)'
      },
      timetable: {
        Hours: hours,
        Days: days,
        Subjects: subjects,
        Teachers: teachers,
        Rooms: rooms,
        Classes: [{ Id: '6A', Abbrev: '6.A', Name: '6. A' }],
        Groups: []
      },
      marks: marksData,
      homeworks: homeworksData
    };
  }
}

/* ==========================================================================
   GRADE PREDICTION & REPORT CARD ENGINE (ODHAD ZNÁMEK NA VYSVĚDČENÍ)
   ========================================================================== */

/**
 * Converts Bakaláři MarkText ("1", "1-", "2*", "3-", etc.) into numeric grade 1.0 - 5.0
 */
function parseBakalariMarkValue(markText) {
  if (!markText) return null;
  const cleaned = String(markText).trim().replace(',', '.');
  if (/^[1-5]-$/.test(cleaned)) {
    return parseInt(cleaned[0], 10) + 0.5;
  }
  if (/^[1-5]\*$/.test(cleaned) || /^[1-5]\+$/.test(cleaned)) {
    return parseInt(cleaned[0], 10);
  }
  const num = parseFloat(cleaned);
  if (!Number.isNaN(num) && num >= 1 && num <= 5) {
    return num;
  }
  return null;
}

/**
 * Estimates final report card grade from weighted average
 * Standard Czech ZŠ thresholds: <=1.50 -> 1, <=2.50 -> 2, <=3.50 -> 3, <=4.50 -> 4, >4.50 -> 5
 */
function estimateFinalGrade(average, thresholdOffset = 0.5) {
  if (average === null || Number.isNaN(average)) return null;
  if (average <= 1 + thresholdOffset) return 1;
  if (average <= 2 + thresholdOffset) return 2;
  if (average <= 3 + thresholdOffset) return 3;
  if (average <= 4 + thresholdOffset) return 4;
  return 5;
}

/**
 * Computes detailed subject grade analysis including What-If support and improvement tip
 */
function analyzeSubjectMarks(subjectEntry, extraMarks = [], thresholdOffset = 0.5) {
  const rawMarks = Array.isArray(subjectEntry.Marks) ? subjectEntry.Marks : [];
  const allMarks = [...rawMarks, ...extraMarks];

  let weightedSum = 0;
  let totalWeight = 0;
  const parsedMarks = [];

  for (const m of allMarks) {
    const val = parseBakalariMarkValue(m.MarkText);
    const weight = Number(m.Weight) > 0 ? Number(m.Weight) : 1;
    if (val !== null) {
      weightedSum += val * weight;
      totalWeight += weight;
    }
    parsedMarks.push({
      ...m,
      numericValue: val,
      effectiveWeight: weight
    });
  }

  let exactAverage = null;
  if (totalWeight > 0) {
    exactAverage = weightedSum / totalWeight;
  } else if (subjectEntry.AverageText) {
    const parsedAvg = parseFloat(String(subjectEntry.AverageText).replace(',', '.'));
    if (!Number.isNaN(parsedAvg)) exactAverage = parsedAvg;
  }

  const estimatedGrade = estimateFinalGrade(exactAverage, thresholdOffset);

  // Calculate helpful tip for the student:
  // Either how many 1s are needed to improve grade, or how close the average is to the boundary
  let adviceText = '';
  let statusType = 'safe'; // 'safe' | 'borderline' | 'improve'

  if (exactAverage !== null && estimatedGrade !== null && totalWeight > 0) {
    if (estimatedGrade > 1) {
      const targetThreshold = (estimatedGrade - 1) + thresholdOffset; // e.g. 1.50 for getting a 1
      // How much weight of "1" do we need so (weightedSum + 1 * w) / (totalWeight + w) <= targetThreshold?
      // weightedSum + w <= targetThreshold * totalWeight + targetThreshold * w
      // weightedSum - targetThreshold * totalWeight <= w * (targetThreshold - 1)
      const neededWeightOfOne = Math.ceil(
        (weightedSum - targetThreshold * totalWeight) / (targetThreshold - 1)
      );
      if (neededWeightOfOne > 0 && neededWeightOfOne <= 15) {
        statusType = 'improve';
        adviceText = `Na známku ${estimatedGrade - 1} na vysvědčení stačí získat jedničku s celkovou váhou alespoň ${neededWeightOfOne} (např. ${neededWeightOfOne <= 5 ? 'jedna menší zkouška/úkol' : 'jeden větší test'}).`;
      } else {
        adviceText = `Průměr ${exactAverage.toFixed(2).replace('.', ',')} odpovídá známce ${estimatedGrade} na vysvědčení.`;
      }
    } else {
      // Estimated grade is 1 - check if close to 1.50
      const upperBound = 1 + thresholdOffset;
      if (exactAverage >= upperBound - 0.12) {
        statusType = 'borderline';
        adviceText = `Těsná jednička (${exactAverage.toFixed(2).replace('.', ',')})! Pozor na hranici ${upperBound.toFixed(2).replace('.', ',')}.`;
      } else {
        statusType = 'safe';
        adviceText = `Krásná a pevná jednička na vysvědčení! Jen tak dál.`;
      }
    }
  } else {
    adviceText = 'Zatím žádné započitatelné známky.';
  }

  return {
    subject: subjectEntry.Subject || { Id: 'UNK', Abbrev: '?', Name: 'Předmět' },
    marks: parsedMarks,
    weightedSum,
    totalWeight,
    exactAverage,
    formattedAverage: exactAverage !== null ? exactAverage.toFixed(2).replace('.', ',') : (subjectEntry.AverageText || '—'),
    estimatedGrade,
    statusType,
    adviceText
  };
}

/**
 * Computes overall Report Card prediction across all subjects
 * Rules for Czech ZŠ "Vyznamenání":
 * - Overall average of final grades <= 1.50
 * - No final grade worse than 2
 */
function analyzeOverallReportCard(subjectsList, whatIfMap = {}, thresholdOffset = 0.5) {
  const analyzedSubjects = (subjectsList || []).map((subjEntry) => {
    const subjId = subjEntry.Subject?.Id || subjEntry.Subject?.Abbrev;
    const extra = whatIfMap[subjId] || [];
    return analyzeSubjectMarks(subjEntry, extra, thresholdOffset);
  });

  const gradedSubjects = analyzedSubjects.filter((s) => s.estimatedGrade !== null);
  const count = gradedSubjects.length;

  if (count === 0) {
    return {
      subjects: analyzedSubjects,
      overallFinalAverage: null,
      overallContinuousAverage: null,
      verdict: 'Zatím neklasifikováno',
      verdictBadge: 'neutral',
      verdictDetail: 'Zatím nejsou k dispozici dostatečné známky.',
      gradeCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    };
  }

  const gradeCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sumFinalGrades = 0;
  let sumContinuousAverages = 0;
  let worstGrade = 1;

  for (const s of gradedSubjects) {
    gradeCounts[s.estimatedGrade] = (gradeCounts[s.estimatedGrade] || 0) + 1;
    sumFinalGrades += s.estimatedGrade;
    sumContinuousAverages += s.exactAverage;
    if (s.estimatedGrade > worstGrade) worstGrade = s.estimatedGrade;
  }

  const overallFinalAverage = sumFinalGrades / count;
  const overallContinuousAverage = sumContinuousAverages / count;

  let verdict = 'Prospěla';
  let verdictBadge = 'good';
  let verdictDetail = '';

  if (worstGrade === 5) {
    verdict = 'Neprospěla';
    verdictBadge = 'danger';
    verdictDetail = 'Pozor, z některého předmětu vychází nedostatečná (5).';
  } else if (worstGrade <= 2 && overallFinalAverage <= 1.5) {
    verdict = 'Prospěla s vyznamenáním 🏆';
    verdictBadge = 'honors';
    const maxTwosAllowed = Math.floor(count * 0.5);
    const currentTwos = gradeCounts[2];
    verdictDetail = `Skvělá práce! Průměr známek na vysvědčení je ${overallFinalAverage.toFixed(2).replace('.', ',')} (${currentTwos}× dvojka z max. ${maxTwosAllowed} pro vyznamenání).`;
  } else {
    verdict = 'Prospěla 👍';
    verdictBadge = 'good';
    if (worstGrade <= 2 && overallFinalAverage > 1.5) {
      const maxTwosAllowed = Math.floor(count * 0.5);
      const excessTwos = gradeCounts[2] - maxTwosAllowed;
      verdictDetail = `K vyznamenání chybí vylepšit ${excessTwos} ${excessTwos === 1 ? 'předmět' : 'předměty'} z dvojky na jedničku.`;
    } else {
      verdictDetail = `Odhadovaný průměr na vysvědčení je ${overallFinalAverage.toFixed(2).replace('.', ',')}.`;
    }
  }

  return {
    subjects: analyzedSubjects,
    overallFinalAverage,
    overallContinuousAverage,
    verdict,
    verdictBadge,
    verdictDetail,
    gradeCounts
  };
}

/* ==========================================================================
   DATE & PREPARATION CHECKLIST HELPERS
   ========================================================================== */

function formatDateIso(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getMondayOfWeek(dateObj) {
  const d = new Date(dateObj);
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ... 6 = Sat
  // If Saturday or Sunday, show next week's Monday if looking ahead, or current week's Monday
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getNextSchoolDay(fromDate = new Date()) {
  const next = new Date(fromDate);
  next.setDate(next.getDate() + 1);
  // Skip Saturday (6) -> Monday (+2), Sunday (0) -> Monday (+1)
  if (next.getDay() === 6) {
    next.setDate(next.getDate() + 2);
  } else if (next.getDay() === 0) {
    next.setDate(next.getDate() + 1);
  }
  next.setHours(0, 0, 0, 0);
  return next;
}

/**
 * Returns default or user-saved extracurricular clubs (Kroužky)
 */
function loadCustomClubs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CUSTOM_CLUBS);
    if (raw) return JSON.parse(raw);
  } catch (_) {}

  // Default sample clubs for daughter so the feature is immediately visible & editable
  const defaults = [
    {
      id: 'club_1',
      name: 'Keramika a výtvarná dílna',
      dayOfWeek: 2, // Úterý
      beginTime: '14:30',
      endTime: '16:00',
      location: 'DDM / Školní družina',
      equipment: 'Pracovní zástěra, přezůvky',
      color: '#ec4899'
    },
    {
      id: 'club_2',
      name: 'Street Dance / Tanečky',
      dayOfWeek: 4, // Čtvrtek
      beginTime: '15:00',
      endTime: '16:15',
      location: 'Malá tělocvična',
      equipment: 'Taneční oblečení, sálovky, láhev na pití',
      color: '#8b5cf6'
    }
  ];
  localStorage.setItem(STORAGE_KEYS.CUSTOM_CLUBS, JSON.stringify(defaults));
  return defaults;
}

function saveCustomClubs(clubs) {
  localStorage.setItem(STORAGE_KEYS.CUSTOM_CLUBS, JSON.stringify(clubs));
}

// Export to global window scope
window.BakalariPWA = {
  STORAGE_KEYS,
  BakalariApiClient,
  parseBakalariMarkValue,
  estimateFinalGrade,
  analyzeSubjectMarks,
  analyzeOverallReportCard,
  formatDateIso,
  getMondayOfWeek,
  getNextSchoolDay,
  loadCustomClubs,
  saveCustomClubs
};

