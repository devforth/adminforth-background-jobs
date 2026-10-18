<template>
  <p
    v-if="!props.jobs.length"
    class="px-3 py-6 text-center text-sm text-lightInputIconColor dark:text-darkInputIconColor"
  >
    {{ t('No jobs yet') }}
  </p>
  <Modal
    ref="modalRef"
    v-for="job in props.jobs" :key="job.id"
    :beforeOpenFunction="() => onBeforeOpen(job)"
    removeFromDomOnClose
  >
    <template #trigger>
      <DropdownMenuItem class="af-background-job-row gap-3 py-2.5">
        <span class="flex flex-col gap-1.5">
          <span class="flex items-baseline justify-between gap-3">
            <span class="truncate font-medium">{{ job.name }}</span>
            <span class="shrink-0 text-xs tabular-nums text-lightInputIconColor dark:text-darkInputIconColor">
              {{ getTimeAgoString(new Date(job.createdAt)) }}
            </span>
          </span>
          <!-- progress matters only while the job still runs, finished jobs show their state icon -->
          <ProgressBar
            v-if="isJobCancellable(job)"
            :current-value="parseInt(job.progress, 10)"
            :showAnimation="job.status === 'IN_PROGRESS'"
            :showLabels="false"
            :showValues="false"
            :show-progress="false"
          />
        </span>
        <template #suffix>
          <StateToIcon :job="job" />
          <!-- cancel right from the list, without opening the job popup -->
          <Tooltip v-if="isJobCancellable(job)">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              iconOnly
              class="hover:text-lightDanger dark:hover:text-darkDanger"
              :disabled="cancellingJobs[job.id]"
              :aria-label="t('Cancel job')"
              @click.stop.prevent="onCancelJob(job)"
            >
              <IconX />
            </Button>
            <template #tooltip>
              {{ t('Cancel job') }}
            </template>
          </Tooltip>
        </template>
      </DropdownMenuItem>
    </template>
    <JobInfoPopup
      v-if="loadedJobs[job.id]"
      :job="loadedJobs[job.id]"
      :meta="meta"
      :closeModal="closeModal"
    />
  </Modal>
</template>


<script setup lang="ts">
import type { IJob } from './utils';
import { cancelJobById, isJobCancellable } from './utils';
import { callAdminForthApi, getTimeAgoString } from '@/utils';
import { Button, DropdownMenuItem, ProgressBar, Modal, Tooltip } from '@/afcl';
import { IconX } from '@iconify-prerendered/vue-lucide';
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
  meta: {
    pluginInstanceId: string;
  };
}>();


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

</script>
