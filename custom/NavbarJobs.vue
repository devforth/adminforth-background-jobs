<template>
  <!-- the list stays mounted while closed, so a job popup opened from it outlives the dropdown -->
  <DropdownMenu
    v-model:open="isDropdownOpen"
    placement="bottom-end"
    keepMounted
    teleportToBody
    contentClass="af-background-jobs-dropdown w-80"
  >
    <template #trigger>
      <Button
        type="button"
        variant="secondary"
        class="relative overflow-hidden"
        :class="{ 'bg-lightButtonGroupActiveBackground hover:bg-lightButtonGroupActiveBackground dark:bg-darkButtonGroupActiveBackground dark:hover:bg-darkButtonGroupActiveBackground': isDropdownOpen }"
        :aria-expanded="isDropdownOpen"
      >
        <template v-if="isAlLeastOneJobRunning">
          <!-- the label already tells the state, the spinner's own "Loading..." would be read before it -->
          <Spinner class="w-4 h-4" aria-hidden="true" />
          <span class="tabular-nums">{{ t('{count} running', { count: jobsCount }) }}</span>
          <span
            class="absolute bottom-0 left-0 h-0.5 bg-lightPrimary transition-[width] duration-500 dark:bg-darkPrimary"
            :style="{ width: `${overallProgress}%` }"
          />
        </template>
        <template v-else>
          <IconLayers class="w-4 h-4" />
          {{ t('Jobs') }}
        </template>
      </Button>
    </template>
    <JobsList :jobs="jobs" :meta="meta" />
  </DropdownMenu>
</template>



<script setup lang="ts">
  import type { AdminUser } from 'adminforth';
  import { onMounted, onUnmounted, ref, computed, watch } from 'vue';
  import { Button, DropdownMenu, Spinner } from '@/afcl';
  import { IconLayers } from '@iconify-prerendered/vue-lucide';
  import { useI18n } from 'vue-i18n';
  import JobsList from './JobsList.vue';
  import type { IJob } from './utils';
  import { callAdminForthApi } from '@/utils';
  import websocket from '@/websocket';
  import { useAdminforth } from '@/adminforth';

  const { t } = useI18n();
  const adminforth = useAdminforth();

  const props = defineProps<{
    meta: {
      pluginInstanceId: string;
    };
    adminUser: AdminUser;
  }>();

  const isDropdownOpen = ref(false);
  const jobs = ref<IJob[]>([]);
  let unsubscribeJobUpdates: (() => void) | undefined;

  watch(isDropdownOpen, (open) => {
    if (open) {
      loadJobs();
    }
  });

  // queued jobs are pending work as well, so they are shown in the badge together with the running ones
  const activeJobs = computed(() => {
    return jobs.value.filter((job: IJob) => job.status === 'IN_PROGRESS' || job.status === 'QUEUED');
  })

  const isAlLeastOneJobRunning = computed(() => {
    return activeJobs.value.length > 0;
  })

  const jobsCount = computed(() => {
    return activeJobs.value.length;
  })

  const overallProgress = computed(() => {
    if (activeJobs.value.length === 0) {
      return 0;
    }

    const totalProgress = activeJobs.value.reduce((sum, job) => {
      const progress = Number(job.progress);
      return sum + (Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0);
    }, 0);

    return Math.round(totalProgress / activeJobs.value.length);
  })

  async function loadJobs() {
    try {
      const res = await callAdminForthApi({
        path: `/plugin/${props.meta.pluginInstanceId}/get-list-of-jobs`,
        method: 'POST',
      });
      jobs.value = res.jobs;
    } catch (error) {
      console.error('Error fetching jobs:', error);
    }
  }

  onMounted(async () => {
    unsubscribeJobUpdates = websocket.subscribe('/background-jobs-job-update', (data) => {
      if (data.status === 'DONE_WITH_ERRORS' && data.error) {
        adminforth.alert({
          message: data.error,
          variant: 'danger',
        });
      }
      const jobIndex = jobs.value.findIndex((job: IJob) => job.id === data.jobId);
      if (jobIndex !== -1) {
        if (data.status) {
          jobs.value[jobIndex].status = data.status;
        }
        if (data.progress !== undefined) {
          jobs.value[jobIndex].progress = data.progress;
        }
        if (data.finishedAt) {
          jobs.value[jobIndex].finishedAt = data.finishedAt;
        }
        if (data.state) {
          jobs.value[jobIndex].state = {
            ...jobs.value[jobIndex].state,
            ...data.state,
          };
        }
      } else if (data.name && data.createdAt) {
        jobs.value.unshift({
          id: data.jobId,
          name: data.name,
          status: data.status || 'IN_PROGRESS',
          state: data.state || {},
          progress: data.progress || 0,
          createdAt: data.createdAt,
          customComponent: data.customComponent,
        });
      }
    });

    await loadJobs();
  });


  onUnmounted(() => {
    unsubscribeJobUpdates?.();
  });

</script>
