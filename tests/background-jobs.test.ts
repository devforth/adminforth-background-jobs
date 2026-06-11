import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminforthMock = vi.hoisted(() => {
  class AdminForthPlugin {
    adminforth: any;
    pluginInstanceId = 'test-plugin';
    resourceConfig: any;

    constructor(public options: any) {}

    modifyResourceConfig(adminforth: any, resourceConfig: any) {
      this.adminforth = adminforth;
      this.resourceConfig = resourceConfig;
    }

    componentPath(file: string) {
      return `component:${file}`;
    }
  }

  return {
    AdminForthPlugin,
    Filters: {
      EQ: (field: string, value: any) => ({ field, operator: 'EQ', value }),
    },
    Sorts: {
      DESC: (field: string) => ({ direction: 'DESC', field }),
    },
    afLogger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
});

const levelMock = vi.hoisted(() => {
  class Level {
    static stores = new Map<string, Map<string, string>>();

    store: Map<string, string>;

    constructor(public path: string) {
      if (!Level.stores.has(path)) {
        Level.stores.set(path, new Map());
      }
      this.store = Level.stores.get(path)!;
    }

    async close() {}

    async del(key: string) {
      this.store.delete(key);
    }

    async get(key: string) {
      return this.store.get(key);
    }

    async put(key: string, value: string) {
      this.store.set(key, value);
    }
  }

  return { Level };
});

vi.mock('adminforth', () => adminforthMock);
vi.mock('level', () => ({ Level: levelMock.Level }));

import BackgroundJobsPlugin from '../index';
import type { PluginOptions } from '../types';

const options: PluginOptions = {
  createdAtField: 'createdAt',
  finishedAtField: 'finishedAt',
  jobHandlerField: 'jobHandler',
  levelDbPath: 'memory:/',
  nameField: 'name',
  progressField: 'progress',
  startedByField: 'startedBy',
  stateField: 'state',
  statusField: 'status',
};

const resourceConfig = {
  columns: [
    { name: 'id', primaryKey: true },
    { name: options.createdAtField },
    { name: options.finishedAtField },
    { name: options.startedByField },
    { name: options.stateField },
    { name: options.progressField },
    { name: options.statusField },
    { name: options.nameField },
    { name: options.jobHandlerField },
  ],
  resourceId: 'backgroundJobs',
};

type MockFilter = {
  field: string;
  value: any;
};

type MockSort = {
  direction: 'DESC';
  field: string;
};

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function matchesFilter(record: Record<string, any>, filter?: MockFilter) {
  if (!filter) {
    return true;
  }
  return record[filter.field] === filter.value;
}

function createMockResource(initialRecords: Record<string, any>[] = []) {
  const records = new Map<string, Record<string, any>>();
  let nextId = 1;

  for (const record of initialRecords) {
    records.set(record.id, clone(record));
  }

  const resource = {
    records,
    create: vi.fn(async (recordToCreate: Record<string, any>) => {
      const id = recordToCreate.id || `job-${nextId++}`;
      const createdRecord = {
        id,
        createdAt: `2026-06-11T00:00:0${nextId}.000Z`,
        finishedAt: null,
        ...clone(recordToCreate),
      };
      records.set(id, createdRecord);
      return { createdRecord, ok: true };
    }),
    get: vi.fn(async (filter: MockFilter) => {
      return Array.from(records.values()).find((record) => matchesFilter(record, filter)) || null;
    }),
    list: vi.fn(async (filter?: MockFilter, limit?: number, offset = 0, sort?: MockSort) => {
      let filteredRecords = Array.from(records.values()).filter((record) => matchesFilter(record, filter));

      if (sort?.direction === 'DESC') {
        filteredRecords = filteredRecords.sort((left, right) => String(right[sort.field]).localeCompare(String(left[sort.field])));
      }

      const end = limit == null ? undefined : offset + limit;
      return filteredRecords.slice(offset, end);
    }),
    update: vi.fn(async (id: string, patch: Record<string, any>) => {
      const record = records.get(id);
      if (!record) {
        return { error: 'not found', ok: false };
      }
      Object.assign(record, clone(patch));
      return { ok: true, updatedRecord: record };
    }),
  };

  return resource;
}

function createMockAdminforth(resource = createMockResource()) {
  return {
    config: {
      componentsToExplicitRegister: [],
      customization: {
        globalInjections: {
          header: [],
        },
      },
    },
    resource: vi.fn(() => resource),
    websocket: {
      publish: vi.fn(),
    },
  };
}

async function createHarness(initialRecords: Record<string, any>[] = []) {
  const resource = createMockResource(initialRecords);
  const adminforth = createMockAdminforth(resource);
  const plugin = new BackgroundJobsPlugin(options);

  await plugin.modifyResourceConfig(adminforth as any, clone(resourceConfig) as any);

  return { adminforth, plugin, resource };
}

function jobStorePath(jobId: string) {
  return `${options.levelDbPath}job_${jobId}`;
}

function getJobStore(jobId: string) {
  const store = levelMock.Level.stores.get(jobStorePath(jobId));
  if (!store) {
    throw new Error(`No mocked LevelDB store for job ${jobId}`);
  }
  return store;
}

function seedTasks(jobId: string, tasks: { state: Record<string, any>; status: string }[]) {
  const store = new Map<string, string>();
  store.set('_meta:count', String(tasks.length));
  tasks.forEach((task, index) => {
    store.set(index.toString(), JSON.stringify(task));
  });
  levelMock.Level.stores.set(jobStorePath(jobId), store);
  return store;
}

function readTask(jobId: string, taskIndex: number) {
  const rawTask = getJobStore(jobId).get(taskIndex.toString());
  return rawTask ? JSON.parse(rawTask) : undefined;
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 1000) {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  if (lastError) {
    throw lastError;
  }
}

function seedJob(overrides: Record<string, any> = {}) {
  return {
    createdAt: '2026-06-11T00:00:00.000Z',
    finishedAt: null,
    id: 'seed-job',
    jobHandler: 'handler',
    name: 'Seed job',
    progress: 0,
    startedBy: 'user-1',
    state: {},
    status: 'IN_PROGRESS',
    ...overrides,
  };
}

describe('BackgroundJobsPlugin job processing', () => {
  beforeEach(() => {
    levelMock.Level.stores.clear();
  });

  it('starts a job, processes tasks, updates progress, and calls finish callbacks', async () => {
    const { adminforth, plugin, resource } = await createHarness();
    const beforeJobFinish = vi.fn();
    const onAllTasksDone = vi.fn();
    const handler = vi.fn(async ({ jobId, setTaskStateField, getTaskStateField, getState }) => {
      const fullState = await getState();
      const input = await getTaskStateField('input');

      expect(jobId).toBe('job-1');
      expect(fullState).toEqual({ input });

      await setTaskStateField('result', input * 2);
    });

    plugin.registerTaskHandler({
      beforeJobFinish,
      handler,
      jobHandlerName: 'double',
      onAllTasksDone,
      parallelLimit: 1,
    });

    const jobId = await plugin.startNewJob(
      'Double numbers',
      { pk: 'user-1' } as any,
      [{ state: { input: 1 } }, { state: { input: 2 } }],
      'double',
      { source: 'unit-test' },
    );

    expect(jobId).toBe('job-1');
    expect(resource.create).toHaveBeenCalledWith({
      jobHandler: 'double',
      name: 'Double numbers',
      progress: 0,
      startedBy: 'user-1',
      state: { source: 'unit-test' },
      status: 'IN_PROGRESS',
    });

    await eventually(() => {
      expect(onAllTasksDone).toHaveBeenCalledWith({ failedTasks: 0, jobId, succeededTasks: 2 });
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(readTask(jobId, 0)).toEqual({ state: { input: 1, result: 2 }, status: 'DONE' });
    expect(readTask(jobId, 1)).toEqual({ state: { input: 2, result: 4 }, status: 'DONE' });

    expect(resource.records.get(jobId)).toMatchObject({
      jobHandler: 'double',
      progress: 100,
      startedBy: 'user-1',
      state: { source: 'unit-test' },
      status: 'DONE',
    });
    expect(resource.records.get(jobId)?.finishedAt).toEqual(expect.any(String));
    expect(beforeJobFinish).toHaveBeenCalledWith({
      failedTasks: 0,
      finishAttemptNumber: 1,
      jobId,
      succeededTasks: 2,
    });
    expect(adminforth.websocket.publish).toHaveBeenCalledWith('/background-jobs-task-update/job-1', {
      status: 'IN_PROGRESS',
      taskIndex: 0,
    });
    expect(adminforth.websocket.publish).toHaveBeenCalledWith('/background-jobs-task-state-update/job-1/result', {
      fieldName: 'result',
      jobId,
      taskIndex: 0,
      value: 2,
    });
    expect(adminforth.websocket.publish).toHaveBeenCalledWith(
      '/background-jobs-job-update',
      expect.objectContaining({ jobId, progress: 100 }),
    );
    expect(adminforth.websocket.publish).toHaveBeenCalledWith(
      '/background-jobs-job-update',
      expect.objectContaining({ jobId, status: 'DONE' }),
    );
  });

  it('marks failed tasks and completes the job with errors', async () => {
    const { adminforth, plugin, resource } = await createHarness();
    const onAllTasksDone = vi.fn();
    const handler = vi.fn(async ({ setTaskStateField, getTaskStateField }) => {
      const input = await getTaskStateField('input');

      if (input === 2) {
        throw new Error('task exploded');
      }

      await setTaskStateField('result', input * 2);
    });

    plugin.registerTaskHandler({
      handler,
      jobHandlerName: 'may-fail',
      onAllTasksDone,
      parallelLimit: 1,
    });

    const jobId = await plugin.startNewJob(
      'May fail',
      { pk: 'user-1' } as any,
      [{ state: { input: 1 } }, { state: { input: 2 } }],
      'may-fail',
      {},
    );

    await eventually(() => {
      expect(onAllTasksDone).toHaveBeenCalledWith({ failedTasks: 1, jobId, succeededTasks: 1 });
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(readTask(jobId, 0)).toEqual({ state: { input: 1, result: 2 }, status: 'DONE' });
    expect(readTask(jobId, 1)).toEqual({ state: { input: 2 }, status: 'FAILED' });
    expect(resource.records.get(jobId)).toMatchObject({
      state: { error: 'task exploded' },
      status: 'DONE_WITH_ERRORS',
    });
    expect(adminforth.websocket.publish).toHaveBeenCalledWith('/background-jobs-state-update/job-1/error', {
      fieldName: 'error',
      jobId,
      value: 'task exploded',
    });
    expect(adminforth.websocket.publish).toHaveBeenCalledWith('/background-jobs-task-update/job-1', {
      status: 'FAILED',
      taskIndex: 1,
    });
  });

  it('reprocesses tasks added by beforeJobFinish before finalizing the job', async () => {
    const { plugin, resource } = await createHarness();
    const handledInputs: string[] = [];
    const onAllTasksDone = vi.fn();
    const beforeJobFinish = vi.fn(async ({ finishAttemptNumber, jobId }) => {
      if (finishAttemptNumber === 1) {
        await plugin.addNewTasksToExistingJob(jobId, [{ state: { input: 'added' } }]);
      }
    });
    const handler = vi.fn(async ({ getTaskStateField }) => {
      handledInputs.push(await getTaskStateField('input'));
    });

    plugin.registerTaskHandler({
      beforeJobFinish,
      handler,
      jobHandlerName: 'reprocess',
      onAllTasksDone,
      parallelLimit: 1,
    });

    const jobId = await plugin.startNewJob(
      'Reprocess',
      { pk: 'user-1' } as any,
      [{ state: { input: 'initial' } }],
      'reprocess',
      {},
    );

    await eventually(() => {
      expect(onAllTasksDone).toHaveBeenCalledWith({ failedTasks: 0, jobId, succeededTasks: 2 });
    });

    expect(handledInputs).toEqual(['initial', 'added']);
    expect(beforeJobFinish).toHaveBeenCalledTimes(2);
    expect(beforeJobFinish.mock.calls.map(([status]) => status.finishAttemptNumber)).toEqual([1, 2]);
    expect(readTask(jobId, 0)).toEqual({ state: { input: 'initial' }, status: 'DONE' });
    expect(readTask(jobId, 1)).toEqual({ state: { input: 'added' }, status: 'DONE' });
    expect(getJobStore(jobId).get('_meta:count')).toBe('2');
    expect(resource.records.get(jobId)).toMatchObject({ progress: 100, status: 'DONE' });
  });

  it('rejects a job start when no task handler is registered', async () => {
    const { plugin, resource } = await createHarness();

    await expect(
      plugin.startNewJob('No handler', { pk: 'user-1' } as any, [{ state: {} }], 'missing-handler'),
    ).rejects.toThrow('No handler registered for jobHandler missing-handler');
    expect(resource.create).not.toHaveBeenCalled();
  });
});

describe('BackgroundJobsPlugin public job and task APIs', () => {
  beforeEach(() => {
    levelMock.Level.stores.clear();
  });

  it('adds tasks to an in-progress job', async () => {
    const { plugin } = await createHarness([seedJob({ id: 'job-add' })]);
    seedTasks('job-add', [
      { state: { input: 1 }, status: 'DONE' },
      { state: { input: 2 }, status: 'SCHEDULED' },
    ]);

    await plugin.addNewTasksToExistingJob('job-add', [{ state: { input: 3 } }, { state: { input: 4 } }]);

    expect(getJobStore('job-add').get('_meta:count')).toBe('4');
    expect(readTask('job-add', 2)).toEqual({ state: { input: 3 }, status: 'SCHEDULED' });
    expect(readTask('job-add', 3)).toEqual({ state: { input: 4 }, status: 'SCHEDULED' });
  });

  it('validates add task preconditions', async () => {
    const { plugin } = await createHarness([seedJob({ id: 'job-done', status: 'DONE' })]);

    await expect(plugin.addNewTasksToExistingJob('missing-job', [{ state: {} }])).rejects.toThrow(
      'Job with id missing-job not found.',
    );
    await expect(plugin.addNewTasksToExistingJob('job-done', [{ state: {} }])).rejects.toThrow(
      'Cannot add tasks to a job with status DONE',
    );
  });

  it('deletes tasks from an in-progress job without compacting indexes', async () => {
    const { plugin } = await createHarness([seedJob({ id: 'job-delete' })]);
    seedTasks('job-delete', [
      { state: { input: 1 }, status: 'DONE' },
      { state: { input: 2 }, status: 'SCHEDULED' },
      { state: { input: 3 }, status: 'SCHEDULED' },
    ]);

    await plugin.deleteTasksFromExistingJob('job-delete', 1);

    expect(getJobStore('job-delete').get('_meta:count')).toBe('2');
    expect(readTask('job-delete', 0)).toEqual({ state: { input: 1 }, status: 'DONE' });
    expect(readTask('job-delete', 1)).toBeUndefined();
    expect(readTask('job-delete', 2)).toEqual({ state: { input: 3 }, status: 'SCHEDULED' });
  });

  it('validates delete task preconditions', async () => {
    const { plugin } = await createHarness([
      seedJob({ id: 'job-delete-active' }),
      seedJob({ id: 'job-delete-done', status: 'DONE' }),
    ]);
    seedTasks('job-delete-active', [{ state: { input: 1 }, status: 'SCHEDULED' }]);
    seedTasks('job-delete-done', [{ state: { input: 1 }, status: 'SCHEDULED' }]);

    await expect(plugin.deleteTasksFromExistingJob('job-delete-active', -1)).rejects.toThrow('Invalid task index -1.');
    await expect(plugin.deleteTasksFromExistingJob('missing-job', 0)).rejects.toThrow('Job with id missing-job not found.');
    await expect(plugin.deleteTasksFromExistingJob('job-delete-active', 1)).rejects.toThrow('Invalid task index 1.');
    await expect(plugin.deleteTasksFromExistingJob('job-delete-done', 0)).rejects.toThrow(
      'Cannot delete tasks from a job with status DONE',
    );
  });

  it('reads and writes job state fields', async () => {
    const { adminforth, plugin, resource } = await createHarness([seedJob({ id: 'job-state', state: { existing: true } })]);

    await plugin.setJobStateField('job-state', 'step/status', 'done');

    expect(await plugin.getJobStateField('job-state', 'step/status')).toBe('done');
    expect(await plugin.getJobState('job-state')).toEqual({ existing: true, 'step/status': 'done' });
    expect(resource.update).toHaveBeenCalledWith('job-state', {
      state: { existing: true, 'step/status': 'done' },
    });
    expect(adminforth.websocket.publish).toHaveBeenCalledWith('/background-jobs-state-update/job-state/step%2Fstatus', {
      fieldName: 'step/status',
      jobId: 'job-state',
      value: 'done',
    });
  });
});

describe('BackgroundJobsPlugin REST endpoint handlers', () => {
  beforeEach(() => {
    levelMock.Level.stores.clear();
  });

  it('maps job list, job info, cancel, and task list responses through mocked endpoints', async () => {
    const { adminforth, plugin, resource } = await createHarness([
      seedJob({
        createdAt: '2026-06-11T00:00:01.000Z',
        id: 'job-user-new',
        jobHandler: 'handler-with-component',
        name: 'Newest user job',
        progress: 50,
        startedBy: 'user-1',
        state: { phase: 'middle' },
      }),
      seedJob({
        createdAt: '2026-06-11T00:00:00.000Z',
        id: 'job-user-old',
        name: 'Old user job',
        progress: 10,
        startedBy: 'user-1',
      }),
      seedJob({
        id: 'job-other-user',
        name: 'Other user job',
        startedBy: 'user-2',
      }),
      seedJob({
        id: 'job-terminal',
        name: 'Terminal job',
        startedBy: 'user-2',
        status: 'DONE',
      }),
    ]);
    const customComponent = { file: 'JobDetails.vue' };
    const endpoints = new Map<string, any>();
    const server = {
      endpoint: vi.fn((definition: any) => {
        endpoints.set(`${definition.method} ${definition.path}`, definition.handler);
      }),
    };

    plugin.registerTaskDetailsComponent({
      component: customComponent as any,
      jobHandlerName: 'handler-with-component',
    });
    seedTasks('job-user-new', [
      { state: { input: 1 }, status: 'DONE' },
      { state: { input: 2 }, status: 'SCHEDULED' },
      { state: { input: 3 }, status: 'FAILED' },
    ]);

    plugin.setupEndpoints(server as any);

    const listJobs = await endpoints.get('POST /plugin/test-plugin/get-list-of-jobs')({
      adminUser: { pk: 'user-1' },
    });
    expect(listJobs).toEqual({
      jobs: [
        {
          createdAt: '2026-06-11T00:00:01.000Z',
          customComponent,
          finishedAt: null,
          id: 'job-user-new',
          name: 'Newest user job',
          progress: 50,
          status: 'IN_PROGRESS',
        },
        {
          createdAt: '2026-06-11T00:00:00.000Z',
          customComponent: undefined,
          finishedAt: null,
          id: 'job-user-old',
          name: 'Old user job',
          progress: 10,
          status: 'IN_PROGRESS',
        },
      ],
    });

    const jobInfo = await endpoints.get('POST /plugin/get-background-job-info')({
      adminUser: { pk: 'user-1' },
      body: { jobId: 'job-user-new' },
    });
    expect(jobInfo).toEqual({
      job: {
        createdAt: '2026-06-11T00:00:01.000Z',
        customComponent,
        finishedAt: null,
        id: 'job-user-new',
        name: 'Newest user job',
        progress: 50,
        state: { phase: 'middle' },
        status: 'IN_PROGRESS',
      },
      ok: true,
    });

    await expect(
      endpoints.get('POST /plugin/get-background-job-info')({
        adminUser: { pk: 'user-1' },
        body: { jobId: 'missing-job' },
      }),
    ).resolves.toEqual({ message: 'Job with id missing-job not found.', ok: false });

    await expect(
      endpoints.get('POST /plugin/test-plugin/cancel-job')({ body: { jobId: 'job-user-new' } }),
    ).resolves.toEqual({ ok: true });
    expect(resource.records.get('job-user-new')).toMatchObject({ status: 'CANCELLED' });
    expect(resource.records.get('job-user-new')?.finishedAt).toEqual(expect.any(String));
    expect(adminforth.websocket.publish).toHaveBeenCalledWith('/background-jobs-job-update', {
      jobId: 'job-user-new',
      status: 'CANCELLED',
    });

    await expect(
      endpoints.get('POST /plugin/test-plugin/cancel-job')({ body: { jobId: 'job-terminal' } }),
    ).resolves.toEqual({ message: 'Cannot cancel a job with status DONE.', ok: false });

    await expect(
      endpoints.get('POST /plugin/test-plugin/get-tasks')({
        body: { jobId: 'job-user-new', limit: 2, offset: 1 },
      }),
    ).resolves.toEqual({
      data: {
        tasks: [
          { state: { input: 2 }, status: 'SCHEDULED' },
          { state: { input: 3 }, status: 'FAILED' },
        ],
        total: 3,
      },
      ok: true,
    });
  });
});
