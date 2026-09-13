(function (global) {
  'use strict';

  const config = global.SUPABASE_CONFIG || {};
  const VALID_TASK_STATUSES = new Set(['active', 'closed']);
  const VERSION = '1.0.0';
  const DEFAULT_TIMEOUT_MS = Number(config.requestTimeoutMs || 15000);

  function ensureReady() {
    return Boolean(config.url && config.anonKey);
  }

  function assertReady() {
    if (!ensureReady()) {
      throw new Error('Supabase URL or anon public key is missing.');
    }
  }

  function createPlatformError(message, response, data) {
    const error = new Error(message || 'Platform request failed.');
    error.name = 'TeacherLiuPlatformError';
    error.status = response ? response.status : 0;
    error.code = data && typeof data === 'object' ? (data.code || '') : '';
    error.details = data && typeof data === 'object' ? (data.details || data.hint || '') : '';
    error.payload = data;
    return error;
  }

  function headers(extra) {
    assertReady();
    return Object.assign({
      apikey: config.anonKey,
      Authorization: 'Bearer ' + config.anonKey,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }, extra || {});
  }

  function restUrl(table, query) {
    assertReady();
    return String(config.url).replace(/\/$/, '') + '/rest/v1/' + table + (query ? '?' + query : '');
  }

  function eqFilter(field, value) {
    return encodeURIComponent(field) + '=eq.' + encodeURIComponent(String(value));
  }

  function isNullFilter(field) {
    return encodeURIComponent(field) + '=is.null';
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const timeout = Number(timeoutMs || DEFAULT_TIMEOUT_MS);
    if (!global.AbortController || !timeout || timeout < 1) {
      return fetch(url, options);
    }

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeout);
    try {
      return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw createPlatformError('The request timed out. Please check the network and try again.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function parseResponse(response) {
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = text;
    }

    if (!response.ok) {
      const message = data && typeof data === 'object'
        ? (data.message || data.error || data.hint || JSON.stringify(data))
        : text;
      throw createPlatformError(message || ('Supabase request failed: ' + response.status), response, data);
    }

    return data;
  }

  async function select(table, query) {
    const response = await fetchWithTimeout(restUrl(table, query || ''), {
      method: 'GET',
      headers: headers()
    });
    const data = await parseResponse(response);
    return Array.isArray(data) ? data : [];
  }

  async function selectOne(table, filters, selectFields) {
    const query = ['select=' + encodeURIComponent(selectFields || '*')]
      .concat(filters || [])
      .concat(['limit=1'])
      .join('&');
    const rows = await select(table, query);
    return rows.length ? rows[0] : null;
  }

  async function insert(table, payload, options) {
    const opts = options || {};
    const response = await fetchWithTimeout(restUrl(table), {
      method: 'POST',
      headers: headers({
        Prefer: opts.returnRepresentation ? 'return=representation' : 'return=minimal'
      }),
      body: JSON.stringify(payload)
    });
    const data = await parseResponse(response);
    if (opts.returnRepresentation) {
      return Array.isArray(data) ? (data[0] || null) : data;
    }
    return null;
  }

  async function updateById(table, id, payload, options) {
    const opts = options || {};
    const response = await fetchWithTimeout(restUrl(table, eqFilter('id', id)), {
      method: 'PATCH',
      headers: headers({
        Prefer: opts.returnRepresentation ? 'return=representation' : 'return=minimal'
      }),
      body: JSON.stringify(payload)
    });
    const data = await parseResponse(response);
    if (opts.returnRepresentation) {
      return Array.isArray(data) ? (data[0] || null) : data;
    }
    return null;
  }

  async function rpc(functionName, payload) {
    assertReady();
    const response = await fetchWithTimeout(
      String(config.url).replace(/\/$/, '') + '/rest/v1/rpc/' + encodeURIComponent(functionName),
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload || {})
      }
    );
    return parseResponse(response);
  }

  function generateTaskCode(length) {
    const count = Math.max(8, Number(length || 12));
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let code = 't_';

    if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(count);
      global.crypto.getRandomValues(bytes);
      for (let i = 0; i < bytes.length; i += 1) {
        code += alphabet[bytes[i] % alphabet.length];
      }
      return code;
    }

    for (let i = 0; i < count; i += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
  }

  function parseStudentListDetailed(value) {
    const rawLines = String(value || '').split(/\r?\n/);
    const classMap = new Map();
    const invalidLines = [];
    let duplicateCount = 0;

    rawLines.forEach(function (rawLine, index) {
      const line = rawLine.trim();
      if (!line) return;

      let className = '';
      let studentName = '';
      const delimited = line.match(/^(.+?)[,，\t;；]+(.+)$/);

      if (delimited) {
        className = delimited[1].trim();
        studentName = delimited[2].trim();
      } else {
        const spaced = line.match(/^(\S+)\s+(.+)$/);
        if (spaced) {
          className = spaced[1].trim();
          studentName = spaced[2].trim();
        }
      }

      if (!className || !studentName) {
        invalidLines.push({ lineNumber: index + 1, text: line });
        return;
      }

      if (!classMap.has(className)) classMap.set(className, []);
      const students = classMap.get(className);
      if (students.indexOf(studentName) === -1) students.push(studentName);
      else duplicateCount += 1;
    });

    const classData = Array.from(classMap.entries()).map(function (entry) {
      return { className: entry[0], students: entry[1] };
    });

    return {
      classData: classData,
      invalidLines: invalidLines,
      duplicateCount: duplicateCount,
      summary: summarizeStudentList(classData)
    };
  }

  function parseStudentList(value) {
    return parseStudentListDetailed(value).classData;
  }

  function summarizeStudentList(classData) {
    const classes = Array.isArray(classData) ? classData.length : 0;
    const students = (Array.isArray(classData) ? classData : []).reduce(function (sum, row) {
      return sum + (row && Array.isArray(row.students) ? row.students.length : 0);
    }, 0);
    return { classes: classes, students: students };
  }

  function extractTaskId(input) {
    if (!input) return '';
    let text = String(input).trim().replace(/\s+/g, ' ');
    if (!text) return '';

    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    let candidate = urlMatch ? urlMatch[0] : text;
    candidate = candidate.replace(/[，。,.；;！!？?）)\]]+$/g, '').trim();

    const directParamMatch = candidate.match(/[?&](taskId|taskid|task|task_code)=([^&#\s]+)/i);
    if (directParamMatch) {
      try {
        return decodeURIComponent(directParamMatch[2])
          .replace(/[，。,.；;！!？?）)\]]+$/g, '')
          .trim();
      } catch (error) {
        return directParamMatch[2].trim();
      }
    }

    try {
      const url = new URL(candidate, global.location ? global.location.href : undefined);
      const taskId = url.searchParams.get('taskId') ||
        url.searchParams.get('taskid') ||
        url.searchParams.get('task') ||
        url.searchParams.get('task_code');
      if (taskId) return taskId.replace(/[，。,.；;！!？?）)\]]+$/g, '').trim();
    } catch (error) {
      // Raw task code.
    }

    return candidate.replace(/[，。,.；;！!？?）)\]]+$/g, '').trim();
  }

  function buildTaskLink(taskCode, baseUrl) {
    const cleanCode = extractTaskId(taskCode);
    const base = String(baseUrl || (global.location ? global.location.href : ''))
      .split('?')[0]
      .split('#')[0];
    return base + '?taskId=' + encodeURIComponent(cleanCode);
  }

  function toDeadlineIso(dateValue) {
    if (!dateValue) return null;
    const date = new Date(String(dateValue) + 'T23:59:59.999');
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function formatDeadline(value, locale) {
    if (!value) return 'None';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'None';
    return new Intl.DateTimeFormat(locale || 'en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(date);
  }

  function getTaskState(task, now) {
    const storedStatus = VALID_TASK_STATUSES.has(task && task.status) ? task.status : 'active';
    const expiresAt = task && task.expires_at ? new Date(task.expires_at) : null;
    const expired = Boolean(
      expiresAt &&
      !Number.isNaN(expiresAt.getTime()) &&
      expiresAt.getTime() < Number(now || Date.now())
    );

    if (storedStatus === 'closed') {
      return { code: 'closed', label: 'Closed', canPlay: false, storedStatus: storedStatus, expired: expired };
    }
    if (expired) {
      return { code: 'expired', label: 'Expired', canPlay: false, storedStatus: storedStatus, expired: true };
    }
    return { code: 'active', label: 'Active', canPlay: true, storedStatus: storedStatus, expired: false };
  }

  function isDuplicateError(error) {
    return Boolean(error && (error.status === 409 || error.code === '23505' || /duplicate|unique/i.test(error.message || '')));
  }

  async function createTask(payload) {
    const suppliedCode = payload && payload.task_code ? extractTaskId(payload.task_code) : '';
    const maxAttempts = suppliedCode ? 1 : 5;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const taskCode = suppliedCode || generateTaskCode();
      const normalized = Object.assign({}, payload || {}, {
        task_code: taskCode,
        creator_id: payload && payload.creator_id ? payload.creator_id : null,
        creator_type: payload && payload.creator_type === 'registered' ? 'registered' : 'anonymous',
        status: VALID_TASK_STATUSES.has(payload && payload.status) ? payload.status : 'active'
      });

      try {
        const created = await insert('tasks', normalized, { returnRepresentation: true });
        return created || normalized;
      } catch (error) {
        if (!suppliedCode && isDuplicateError(error) && attempt < maxAttempts - 1) continue;
        throw error;
      }
    }

    throw new Error('Could not generate a unique taskId. Please try again.');
  }

  async function loadTask(taskCode) {
    const cleanCode = extractTaskId(taskCode);
    if (!cleanCode) return null;
    return selectOne('tasks', [eqFilter('task_code', cleanCode)], '*');
  }

  async function loadTaskResults(taskCode, order) {
    const cleanCode = extractTaskId(taskCode);
    if (!cleanCode) return [];
    const query = [
      eqFilter('task_code', cleanCode),
      'select=*',
      'order=' + encodeURIComponent(order || 'class_name.asc,student_name.asc')
    ].join('&');
    return select('task_results', query);
  }

  async function updateTaskStatus(taskCode, status) {
    if (!VALID_TASK_STATUSES.has(status)) throw new Error('Invalid task status.');
    const cleanCode = extractTaskId(taskCode);
    if (!cleanCode) throw new Error('Task ID is missing.');
    const data = await rpc('set_task_status', {
      p_task_code: cleanCode,
      p_status: status
    });
    return Array.isArray(data) ? (data[0] || null) : data;
  }

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  async function submitBestResult(options) {
    const opts = options || {};
    let task = opts.task;
    const gameKey = String(opts.gameKey || '').trim();
    const className = String(opts.className || '').trim();
    const studentName = String(opts.studentName || '').trim();
    const score = numberOrZero(opts.score);
    const accuracy = numberOrZero(opts.accuracy);
    const durationSeconds = Math.max(0, Math.round(numberOrZero(opts.durationSeconds)));
    const resultData = opts.resultData && typeof opts.resultData === 'object' ? opts.resultData : {};
    const completedAt = opts.completedAt || new Date().toISOString();

    if (!task || !task.task_code) throw new Error('Task information is missing.');
    if (!gameKey) throw new Error('Game key is missing.');

    if (opts.verifyTaskState !== false) {
      const freshTask = await loadTask(task.task_code);
      if (!freshTask) throw new Error('This task could not be found.');
      task = freshTask;
    }

    const taskState = getTaskState(task);
    if (!taskState.canPlay) {
      throw new Error(taskState.code === 'closed' ? 'This task is closed.' : 'This task has expired.');
    }

    const filters = [
      eqFilter('task_code', task.task_code),
      eqFilter('game_key', gameKey),
      className ? eqFilter('class_name', className) : isNullFilter('class_name'),
      studentName ? eqFilter('student_name', studentName) : isNullFilter('student_name')
    ];

    const existing = await selectOne(
      'task_results',
      filters,
      'id,attempts,score,accuracy,duration_seconds,result_data,completed_at'
    );

    const basePayload = {
      task_id: task.id || null,
      task_code: task.task_code,
      game_key: gameKey,
      class_name: className || null,
      student_name: studentName || null,
      score: score,
      accuracy: accuracy,
      duration_seconds: durationSeconds,
      completed_at: completedAt,
      updated_at: completedAt
    };

    if (!existing) {
      try {
        await insert('task_results', Object.assign({}, basePayload, {
          attempts: 1,
          result_data: Object.assign({}, resultData, {
            bestScore: score,
            bestAccuracy: accuracy,
            bestDurationSeconds: durationSeconds,
            bestCompletedAt: completedAt,
            latestScore: score,
            latestAccuracy: accuracy,
            latestDurationSeconds: durationSeconds,
            latestCompletedAt: completedAt
          })
        }));
        return { attempts: 1, bestScore: score, isNewBest: true };
      } catch (error) {
        if (!isDuplicateError(error)) throw error;
        // A simultaneous submission inserted the row first. Read it and continue as an update.
      }
    }

    const row = existing || await selectOne(
      'task_results',
      filters,
      'id,attempts,score,accuracy,duration_seconds,result_data,completed_at'
    );
    if (!row) throw new Error('Could not read the existing result row.');

    const previousBestScore = numberOrZero(row.score);
    const isNewBest = score >= previousBestScore;
    const previousData = row.result_data && typeof row.result_data === 'object' ? row.result_data : {};
    const attempts = numberOrZero(row.attempts || 1) + 1;

    await updateById('task_results', row.id, Object.assign({}, basePayload, {
      score: isNewBest ? score : row.score,
      accuracy: isNewBest ? accuracy : row.accuracy,
      duration_seconds: isNewBest ? durationSeconds : row.duration_seconds,
      attempts: attempts,
      result_data: Object.assign({}, previousData, resultData, {
        bestScore: isNewBest ? score : row.score,
        bestAccuracy: isNewBest ? accuracy : row.accuracy,
        bestDurationSeconds: isNewBest ? durationSeconds : row.duration_seconds,
        bestCompletedAt: isNewBest ? completedAt : (previousData.bestCompletedAt || row.completed_at),
        latestScore: score,
        latestAccuracy: accuracy,
        latestDurationSeconds: durationSeconds,
        latestCompletedAt: completedAt
      })
    }));

    return {
      attempts: attempts,
      bestScore: isNewBest ? score : row.score,
      isNewBest: isNewBest
    };
  }

  const api = Object.freeze({
    version: VERSION,
    ensureReady: ensureReady,
    headers: headers,
    restUrl: restUrl,
    eqFilter: eqFilter,
    isNullFilter: isNullFilter,
    select: select,
    selectOne: selectOne,
    insert: insert,
    updateById: updateById,
    rpc: rpc,
    generateTaskCode: generateTaskCode,
    parseStudentList: parseStudentList,
    parseStudentListDetailed: parseStudentListDetailed,
    summarizeStudentList: summarizeStudentList,
    extractTaskId: extractTaskId,
    buildTaskLink: buildTaskLink,
    toDeadlineIso: toDeadlineIso,
    formatDeadline: formatDeadline,
    getTaskState: getTaskState,
    createTask: createTask,
    loadTask: loadTask,
    loadTaskResults: loadTaskResults,
    updateTaskStatus: updateTaskStatus,
    submitBestResult: submitBestResult
  });

  global.TeacherLiuPlatform = api;
  global.TaskSystem = api;
})(window);
