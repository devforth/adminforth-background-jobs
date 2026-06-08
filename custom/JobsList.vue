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
          <div class="flex flex-col w-full max-w-48">
            <p class="flex gap-2 items-end justify-between text-nowrap">
              <span class="text-sm h-full text truncate dark:text-white">{{ job.name }}</span> 
              <span class="text-xs dark:text-gray-200 text-gray-600">{{ getTimeAgoString(new Date(job.createdAt)) }}</span> 
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
import { callAdminForthApi, getTimeAgoString } from '@/utils';
import { ProgressBar, Modal } from '@/afcl';
import JobInfoPopup from './JobInfoPopup.vue';
import StateToIcon from './StateToIcon.vue';
import { ref } from 'vue';

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
