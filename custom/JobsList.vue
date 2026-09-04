<template>
  <div class="w-64 bg-white border border-gray-200 dark:bg-gray-800 dark:border-gray-600 rounded-md overflow-x-hidden">
    <Modal 
      ref="modalRef"
      class="p-4"
      v-for="job in props.jobs" :key="job.id" 
      :beforeCloseFunction="onBeforeClose" 
      :beforeOpenFunction="() => onBeforeOpen(job)"
      removeFromDomOnClose
    >
      <template #trigger>
        <div class="flex items-center w-full px-4 py-3 bg-white dark:bg-gray-700 dark:border-gray-600 border-b border-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors">
          <div class="flex flex-col flex-1 min-w-0">
            <p class="flex gap-2 items-end justify-between text-nowrap">
              <span class="text-sm h-full text truncate dark:text-white">{{ job.name }}</span>
              <span class="text-xs dark:text-gray-200 text-gray-600 shrink-0">{{ getTimeAgoString(new Date(job.createdAt)) }}</span>
            </p>
            <ProgressBar 
              class="mt-1"
              :current-value="parseInt(job.progress, 10)" 
              :max-value="100" 
              :min-value="0"
              :showAnimation="job.status === 'IN_PROGRESS'"
              :showLabels="false"
              :showValues="false"
              :show-progress="false"
            />
          </div>
          <StateToIcon :job="job" />
          <!-- cancel right from the list, without opening the job popup -->
          <Tooltip v-if="isJobCancellable(job)">
            <button
              type="button"
              class="ml-1 shrink-0 flex items-center justify-center w-5 h-5 rounded text-gray-400 hover:text-red-600 hover:bg-gray-100 dark:hover:bg-gray-600 dark:hover:text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="cancellingJobs[job.id]"
              :aria-label="t('Cancel job')"
              @click.stop.prevent="onCancelJob(job)"
            >
              <IconCloseOutline class="w-4 h-4" />
            </button>
            <template #tooltip>
              {{ t('Cancel job') }}
            </template>
          </Tooltip>
        </div>
      </template>
      <JobInfoPopup
        v-if="loadedJobs[job.id]"
        :job="loadedJobs[job.id]"
        :meta="meta"
        :closeModal="closeModal"
      />
    </Modal>

  </div>
</template>


<script setup lang="ts">
import type { IJob } from './utils';
import { cancelJobById, isJobCancellable } from './utils';
import { callAdminForthApi, getTimeAgoString } from '@/utils';
import { ProgressBar, Modal, Tooltip } from '@/afcl';
import { IconCloseOutline } from '@iconify-prerendered/vue-flowbite';
import { useI18n } from 'vue-i18n';
import JobInfoPopup from './JobInfoPopup.vue';
import StateToIcon from './StateToIcon.vue';
import { ref } from 'vue';

const { t } = useI18n();

const modalRef = ref<any>(null);

function closeModal() {
  const m = modalRef.value;
  if (!m) return;

  if (typeof m.close === 'function') {
    m.close();
    return;
  }

  if (Array.isArray(m)) {
    m.forEach((inst: any) => {
      if (inst?.close && typeof inst.close === 'function') {
        inst.close();
      }
    });
  }
}

const props = defineProps<{
  jobs: IJob[];
  closeDropdown: () => void;
  meta: {
    pluginInstanceId: string;
  };
}>();


const isModalOpen = ref(false);
const loadedJobs = ref<Record<string, IJob>>({});
const cancellingJobs = ref<Record<string, boolean>>({});

async function onCancelJob(job: IJob) {
  if (cancellingJobs.value[job.id]) {
    return;
  }
  cancellingJobs.value[job.id] = true;
  try {
    await cancelJobById({
      jobId: job.id,
      pluginInstanceId: props.meta.pluginInstanceId,
      t,
    });
  } finally {
    delete cancellingJobs.value[job.id];
  }
}

async function onBeforeOpen(job: IJob) {
  props.closeDropdown();
  try {
    const res = await callAdminForthApi({
      path: `/plugin/get-background-job-info`,
      method: 'POST',
      body: { jobId: job.id },
    });

    if (res?.ok && res.job) {
      loadedJobs.value[job.id] = res.job;
      return;
    }

    console.log('[background-jobs] failed to load full job info', {
      jobId: job.id,
      response: res,
    });
  } catch (error) {
    console.log('[background-jobs] failed to load full job info', {
      error,
      jobId: job.id,
    });
  }

  loadedJobs.value[job.id] = job;
}

function onBeforeClose() {
  isModalOpen.value = false;
}

  
</script>
