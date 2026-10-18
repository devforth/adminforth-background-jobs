<template>
  <div class="af-background-job-popup flex flex-col w-full sm:min-w-[28rem] max-w-3xl">
    <div class="flex items-start gap-3 px-5 py-4 border-b border-lightDialogBreakLine dark:border-darkDialogBreakLine">
      <div class="flex flex-col gap-0.5 min-w-0 flex-1">
        <h3 class="text-base font-semibold truncate text-lightDialogHeaderText dark:text-darkDialogHeaderText">{{ job.name }}</h3>
        <div class="flex flex-wrap gap-x-3 text-xs text-lightInputIconColor dark:text-darkInputIconColor">
          <Tooltip>
            <span>{{ t('Created:') }} {{ getTimeAgoString(new Date(job.createdAt)) }}</span>
            <template #tooltip>
              {{ t('Created at:') }} {{ formatDateTime(job.createdAt) }}
            </template>
          </Tooltip>
          <Tooltip v-if="job.finishedAt">
            <span>{{ t('Finished:') }} {{ getTimeAgoString(new Date(job.finishedAt)) }}</span>
            <template #tooltip>
              {{ t('Finished at:') }} {{ formatDateTime(job.finishedAt) }}
            </template>
          </Tooltip>
        </div>
      </div>
      <Button type="button" variant="ghost" size="sm" iconOnly :aria-label="t('Close Modal')" @click="closeModal()">
        <IconX />
      </Button>
    </div>

    <div class="flex flex-col gap-4 px-5 py-4 text-sm text-lightDialogBodyText dark:text-darkDialogBodyText">
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3">
          <span class="flex items-center gap-2 font-medium text-lightDialogHeaderText dark:text-darkDialogHeaderText">
            <StateToIcon :job="job" />
            {{ t('Progress') }}
          </span>
          <span class="tabular-nums text-lightInputIconColor dark:text-darkInputIconColor">{{ job.progress }}%</span>
        </div>
        <ProgressBar
          :current-value="parseInt(job.progress, 10)"
          :showAnimation="job.status === 'IN_PROGRESS'"
          :showLabels="false"
          :showValues="false"
          :show-progress="false"
        />
      </div>

      <div
        v-if="tasksStorageLost"
        class="flex items-start gap-2 p-3 rounded-default border border-lightWarningBorder bg-lightWarningSoft text-lightWarning dark:border-darkWarningBorder dark:bg-darkWarningSoft dark:text-darkWarning"
      >
        <IconTriangleAlert class="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <span>{{ t('Task details are no longer available: the task storage of this job was deleted.') }}</span>
      </div>

      <component
        v-if="job.customComponent"
        :is="getCustomComponent(job.customComponent)"
        :meta="job.customComponent"
        :getJobTasks="getJobTasks"
        :tasksStorageLost="tasksStorageLost"
        :job="job"
        :subscribeToJobStateFields="subscribeToJobStateFields"
        :subscribeToJobTaskFields="subscribeToJobTaskFields"
      />
    </div>

    <div
      v-if="isJobCancellable(job)"
      class="flex justify-end px-5 py-3 border-t rounded-b-xl border-lightDialogBreakLine bg-lightFormHeading dark:border-darkDialogBreakLine dark:bg-darkFormHeading"
    >
      <Button type="button" variant="danger" @click="cancelJob">{{ t('Cancel job') }}</Button>
    </div>
  </div>
</template>




<script setup lang="ts">
import type { IJob } from './utils';
import { cancelJobById, isJobCancellable } from './utils';
import { ProgressBar, Button, Tooltip } from '@/afcl';
import { IconTriangleAlert, IconX } from '@iconify-prerendered/vue-lucide';
import { getTimeAgoString, callAdminForthApi, getCustomComponent, formatDateTime} from '@/utils';
import { useI18n } from 'vue-i18n';
import StateToIcon from './StateToIcon.vue';
import { useAdminforth } from '@/adminforth';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import websocket from '@/websocket';
import { useBackgroundJobApi } from './useBackgroundJobApi';


const { t } = useI18n();

const adminforth = useAdminforth();
const jobStore = useBackgroundJobApi();

const props = defineProps<{
  job: IJob;
  meta: {
    pluginInstanceId: string;
  };
  closeModal: () => void;
}>();

type JobTask = {
  state: Record<string, any>;
  status: string;
};

type JobStateFieldUpdate = {
  jobId: string;
  fieldName: string;
  value: any;
};

type TaskStateFieldUpdate = JobStateFieldUpdate & {
  taskIndex: number;
};

const jobTasks = ref<JobTask[]>([]);
const tasksStorageLostForJobId = ref<string | null>(null);
const tasksStorageLost = computed(() => tasksStorageLostForJobId.value === props.job.id);
const subscriptionCleanups = new Set<() => void>();

function getUniqueFieldNames(fieldNames: string[]): string[] {
  return Array.from(new Set(fieldNames.filter((fieldName) => typeof fieldName === 'string' && fieldName.length > 0)));
}

function createStateFieldSubscription(
  fieldNames: string[],
  pathFactory: (fieldName: string) => string,
  callback: (data: any) => void,
) {
  const paths = getUniqueFieldNames(fieldNames).map(pathFactory);
  const pathCleanups = paths.map((path) => websocket.subscribe(path, callback));

  const unsubscribe = () => {
    for (const cleanup of pathCleanups) {
      cleanup();
    }
    subscriptionCleanups.delete(unsubscribe);
  };
  subscriptionCleanups.add(unsubscribe);
  return unsubscribe;
}

function handleJobStateFieldUpdate(data: JobStateFieldUpdate) {
  if (data.jobId !== props.job.id) {
    return;
  }

  props.job.state[data.fieldName] = data.value;
  if (jobStore.currentJob?.id === props.job.id) {
    jobStore.updateCurrentJob({
      state: {
        ...props.job.state,
      },
    });
  }
}

function handleTaskStateFieldUpdate(data: TaskStateFieldUpdate) {
  if (data.jobId !== props.job.id || !jobTasks.value[data.taskIndex]) {
    return;
  }

  jobTasks.value[data.taskIndex].state = {
    ...jobTasks.value[data.taskIndex].state,
    [data.fieldName]: data.value,
  };
}

function handleTaskStatusUpdate(data: { taskIndex: number; status: string; error?: string }) {
  if (!jobTasks.value[data.taskIndex]) {
    return;
  }

  jobTasks.value[data.taskIndex].status = data.status;
  if (data.error !== undefined) {
    jobTasks.value[data.taskIndex].state = {
      ...jobTasks.value[data.taskIndex].state,
      error: data.error,
    };
  }
}

function handleJobUpdate(data: {
  jobId: string;
  status?: IJob['status'];
  progress?: string;
  finishedAt?: Date;
  state?: Record<string, any>;
}) {
  if (data.jobId !== props.job.id) {
    return;
  }

  if (data.status) {
    props.job.status = data.status;
  }
  if (data.progress !== undefined) {
    props.job.progress = data.progress;
  }
  if (data.finishedAt) {
    props.job.finishedAt = data.finishedAt;
  }
  if (data.state) {
    props.job.state = {
      ...props.job.state,
      ...data.state,
    };
  }
  if (jobStore.currentJob?.id === props.job.id) {
    jobStore.updateCurrentJob({
      status: props.job.status,
      progress: props.job.progress,
      finishedAt: props.job.finishedAt,
      state: props.job.state,
    });
  }
}

function subscribeToJobStateFields(fieldNames: string[]) {
  return createStateFieldSubscription(
    fieldNames,
    (fieldName) => `/background-jobs-state-update/${props.job.id}/${encodeURIComponent(fieldName)}`,
    handleJobStateFieldUpdate,
  );
}

function subscribeToJobTaskFields(fieldNames: string[]) {
  return createStateFieldSubscription(
    fieldNames,
    (fieldName) => `/background-jobs-task-state-update/${props.job.id}/${encodeURIComponent(fieldName)}`,
    handleTaskStateFieldUpdate,
  );
}

async function cancelJob() {
  await cancelJobById({
    jobId: props.job.id,
    pluginInstanceId: props.meta.pluginInstanceId,
    t,
  });
}



async function getJobTasks(limit: number = 10, offset: number = 0, fieldsToReturn?: string[]): Promise<JobTask[]> {
  // the level db of the job was deleted, it never comes back, so stop calling the api no matter how many
  // times the task details component asks for tasks again
  if (tasksStorageLost.value) {
    return [];
  }
  try {
    const res = await callAdminForthApi({
      path: `/plugin/${props.meta.pluginInstanceId}/get-tasks`,
      method: 'POST',
      body: {
        jobId: props.job.id,
        limit,
        offset,
        fieldsToReturn,
      },
    });
    if (res.ok) {
      if (res.data.storageLost) {
        tasksStorageLostForJobId.value = props.job.id;
      }
      const tasks = res.data.tasks as JobTask[];
      const startIndex = offset || 0;
      for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
        jobTasks.value[startIndex + taskIndex] = tasks[taskIndex];
      }
      return jobTasks.value.slice(startIndex, startIndex + tasks.length);
    } else {
      console.error('Error fetching job tasks:', res.error);
      return [];
    }
  } catch (error) {
    console.error('Error fetching job tasks:', error);
    return [];
  }
}

watch(
  () => props.job.state?.error,
  (error) => {
    if (error) {
      adminforth.alert({
        message: error,
        variant: 'danger',
      });
    }
  },
  { immediate: true }
);

onMounted(() => {
  const taskStatusPath = `/background-jobs-task-update/${props.job.id}`;
  subscriptionCleanups.add(websocket.subscribe(taskStatusPath, handleTaskStatusUpdate));

  subscriptionCleanups.add(websocket.subscribe('/background-jobs-job-update', handleJobUpdate));
});

onBeforeUnmount(() => {
  for (const unsubscribe of Array.from(subscriptionCleanups)) {
    unsubscribe();
  }
});



</script>
