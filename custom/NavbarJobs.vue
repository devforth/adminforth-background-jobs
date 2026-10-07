<template>
  <div class="relative" ref="dropdownRef">
    <button
      type="button"
      class="relative flex h-10 cursor-pointer items-center gap-2 overflow-hidden rounded-full border pl-3.5 transition-colors"
      :class="isAlLeastOneJobRunning
        ? 'pr-2 bg-lightSecondary border-lightPrimary/45 ring-[3px] ring-lightPrimary/10 text-lightPrimary dark:bg-darkSecondary dark:border-darkPrimary/45 dark:ring-darkPrimary/10 dark:text-darkPrimary'
        : 'pr-4 shadow-sm bg-lightSecondary border-lightSecondaryContrast/15 text-lightNavbarIcons hover:bg-lightSecondaryDarken dark:bg-darkSecondary dark:border-darkSecondaryContrast/15 dark:text-darkNavbarIcons dark:hover:bg-darkSecondaryLighten'"
      :aria-expanded="isDropdownOpen"
      :aria-label="t('Jobs')"
      @click="toggleJobsDropdown"
    >
      <Tooltip>
        <IconCog6Tooth
          class="w-5 h-5"
          :class="{ 'animate-[spin_3s_linear_infinite] motion-reduce:animate-none': isAlLeastOneJobRunning }"
        />
        <template #tooltip>
          {{ isAlLeastOneJobRunning ? t('Jobs in progress') : t('All jobs completed') }}
        </template>
      </Tooltip>
      <span
        class="jobs-label text-sm font-semibold text-lightPrimary dark:text-darkPrimary"
        :class="{ 'jobs-label--pulse': isAlLeastOneJobRunning }"
      >
        {{ t('Jobs') }}
      </span>
      <span
        v-if="isAlLeastOneJobRunning"
        class="flex h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold tabular-nums bg-lightPrimary/15 dark:bg-darkPrimary/20"
      >
        {{ jobsCount }}
      </span>
      <span
        v-if="isAlLeastOneJobRunning"
        class="absolute bottom-0 left-0 h-0.5 bg-lightPrimary transition-[width] duration-500 dark:bg-darkPrimary"
        :style="{ width: `${overallProgress}%` }"
      />
    </button>
    <Transition
      enter-active-class="transition ease-out duration-200"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition ease-in duration-150"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-show="isDropdownOpen" class="absolute right-0 top-14 md:top-12 rounded z-10 overflow-y-auto max-h-96 ">
        <JobsList 
          :closeDropdown="() => isDropdownOpen = false"
          :jobs="jobs" 
          :meta="meta"
        />
      </div>
    </Transition>
  </div>

  
</template>



<script setup lang="ts">
  import type { AdminUser } from 'adminforth';
  import { onMounted, onUnmounted, ref, computed } from 'vue';
  import { Tooltip } from '@/afcl';
  import { IconCog6Tooth } from '@iconify-prerendered/vue-heroicons';
  import { useI18n } from 'vue-i18n';
  import JobsList from './JobsList.vue';
  import type { IJob } from './utils';
  import { callAdminForthApi } from '@/utils';
  import websocket from '@/websocket';
  import { onClickOutside } from '@vueuse/core'
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
  const dropdownRef = ref<HTMLElement | null>(null);
  let unsubscribeJobUpdates: (() => void) | undefined;

  onClickOutside(dropdownRef, () => {
    isDropdownOpen.value = false;
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

  async function toggleJobsDropdown() {
    if (isDropdownOpen.value) {
      isDropdownOpen.value = false;
      return;
    }
    await loadJobs();
    isDropdownOpen.value = true;
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


<style scoped lang="scss">
// the label always glows with the theme primary color, and pulses while jobs are running
.jobs-label {
  --jobs-glow: theme('colors.lightPrimary');
  text-shadow: 0 0 10px color-mix(in srgb, var(--jobs-glow) 55%, transparent);
}

.dark .jobs-label {
  --jobs-glow: theme('colors.darkPrimary');
}

.jobs-label--pulse {
  animation: jobs-glow 1.8s ease-in-out infinite;
}

@keyframes jobs-glow {
  0%, 100% {
    text-shadow:
      0 0 4px color-mix(in srgb, var(--jobs-glow) 40%, transparent),
      0 0 10px color-mix(in srgb, var(--jobs-glow) 25%, transparent);
  }
  50% {
    text-shadow:
      0 0 6px color-mix(in srgb, var(--jobs-glow) 90%, transparent),
      0 0 18px color-mix(in srgb, var(--jobs-glow) 65%, transparent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .jobs-label--pulse {
    animation: none;
  }
}
</style>
