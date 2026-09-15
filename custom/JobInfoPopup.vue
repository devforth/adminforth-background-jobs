<template> 
    <div class="flex flex-col w-full min-w-96 mt-2">
      <div class="flex items-center mb-1">
        <div class="flex flex-col items-start justify-end h-12">
          <h2 class="text-lg font-semibold dark:text-white">{{ job.name }}</h2>
          <Tooltip>
            <p class="text-xs text-gray-600 dark:text-gray-200 h-full">{{ t('Created:') }} {{ getTimeAgoString(new Date(job.createdAt)) }}</p>
            <template #tooltip>
              {{ t('Created at:') }} {{ formatDateTime(job.createdAt) }}
            </template>
          </Tooltip>
        </div>
        <div class="ml-auto flex flex-col items-start justify-end h-12">
          <div class="flex items-center mr-6">
            <p class=" text-gray-800 dark:text-white h-full"> {{  t('Progress:')  }} <span class="font-semibold" >{{ job.progress }}%</span></p>
            <StateToIcon :job="job" />
            <button
              @click="closeModal()"
              type="button"
              class="absolute top-2 right-2 text-lightDialogCloseButton bg-transparent hover:bg-lightDialogCloseButtonHoverBackground hover:text-lightDialogCloseButtonHover rounded-lg text-sm w-8 h-8 ms-auto inline-flex justify-center items-center dark:text-darkDialogCloseButton dark:hover:bg-darkDialogCloseButtonHoverBackground dark:hover:text-darkDialogCloseButtonHover"
            >
              <svg class="w-3 h-3" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 14 14">
                <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m1 1 6 6m0 0 6 6M7 7l6-6M7 7l-6 6"/>
              </svg>
              <span class="sr-only">{{ t('Close Modal') }}</span>
            </button>
          </div>
          <Tooltip v-if="job.finishedAt">
             <p class="text-xs text-gray-600 dark:text-gray-200 h-full"> {{ t('Finished:') }} {{ getTimeAgoString(new Date(job.finishedAt)) }}</p>
            <template #tooltip>
              {{ t('Finished at:') }} {{ formatDateTime(job.finishedAt) }}
            </template>
          </Tooltip>
        </div>
      </div>
      <div class="flex items-center gap-4 w-full mt-4">
        <ProgressBar 
          :current-value="parseInt(job.progress, 10)" 
          :max-value="100" 
          :min-value="0"
          :showAnimation="job.status === 'IN_PROGRESS'"
          :showLabels="false"
          :showValues="false"
          :show-progress="false"
          :height="3"
        />
        <Button class="h-8" v-if="isJobCancellable(job)" @click="cancelJob"> {{ t('Cancel') }} </Button>
      </div>
    </div>
    <div
      v-if="tasksStorageLost"
      class="flex items-start gap-2 w-full mt-4 p-3 rounded-lg text-sm border border-yellow-300 bg-yellow-50 text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200"
    >
      <svg class="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 20 20">
        <path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM9.5 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM12 15H8a1 1 0 0 1 0-2h1v-3H8a1 1 0 0 1 0-2h2a1 1 0 0 1 1 1v4h1a1 1 0 0 1 0 2Z"/>
      </svg>
      <span>{{ t('Task details are no longer available: the task storage of this job was deleted.') }}</span>
    </div>
    <component 
      v-if="job.customComponent"
      class="mt-4" 
      :is="getCustomComponent(job.customComponent)" 
      :meta="job.customComponent"
      :getJobTasks="getJobTasks"
      :tasksStorageLost="tasksStorageLost"
      :job="job"
      :subscribeToJobStateFields="subscribeToJobStateFields"
      :subscribeToJobTaskFields="subscribeToJobTaskFields"
    />
</template>




<script setup lang="ts">
import type { IJob } from './utils';
import { cancelJobById, isJobCancellable } from './utils';
import { ProgressBar, Button, Tooltip } from '@/afcl';
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
