<template>
  <div ref="dropdownRef">
    <div class="cursor-pointer hover:scale-110 transition-transform" @click="isDropdownOpen = !isDropdownOpen">
      <div class="relative flex items-center justify-center" v-if="jobs.length > 0">
        <Tooltip>
          <IconBriefcaseSolid class="w-7 h-7 text-gray-600 hover:text-gray-700" />
          <template #tooltip>
            {{ t('All jobs completed') }}
          </template>
        </Tooltip>
        <div
          v-if="isAlLeastOneJobRunning" 
          class="ping-animation absolute -bottom-1 -right-1 rounded-full bg-lightPrimary w-4 h-4 text-xs flex items-center justify-center text-white"
        >
          {{ jobsCount }}
        </div>
        <div 
          v-if="isAlLeastOneJobRunning" 
          class="absolute -bottom-1 -right-1 rounded-full bg-lightPrimary w-4 h-4 text-xs flex items-center justify-center text-white"
        >
          {{ jobsCount }}
        </div>
      </div>
    </div>
    <Transition
      enter-active-class="transition ease-out duration-200"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition ease-in duration-150"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div v-show="isDropdownOpen" class="absolute right-28 top-14 md:top-12 rounded z-10 overflow-y-auto max-h-96 ">
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
  import { IconCheckCircleOutline, IconBriefcaseSolid } from '@iconify-prerendered/vue-flowbite';
  import { Tooltip } from '@/afcl';
  import { useI18n } from 'vue-i18n';
  import JobsList from './JobsList.vue';
  import type { IJob } from './utils';
  import { callAdminForthApi } from '@/utils';
  import websocket from '@/websocket';
  import { onClickOutside } from '@vueuse/core'

  const { t } = useI18n();

  const props = defineProps<{
    meta: {
      pluginInstanceId: string;
    };
    adminUser: AdminUser;
  }>();

  const isDropdownOpen = ref(false);
  const jobs = ref<IJob[]>([]);
  const dropdownRef = ref<HTMLElement | null>(null);

  onClickOutside(dropdownRef, () => {
    isDropdownOpen.value = false;
  });

  const isAlLeastOneJobRunning = computed(() => {
    return jobs.value.some(job => job.status === 'IN_PROGRESS');
  })

  const jobsCount = computed(() => {
    return jobs.value.filter(job => job.status === 'IN_PROGRESS').length;
  })



  onMounted(async () => {
    websocket.subscribe('/background-jobs', (data) => {
      const jobIndex = jobs.value.findIndex(job => job.id === data.jobId);
      if (jobIndex !== -1) {
        if (data.status) {
          jobs.value[jobIndex].status = data.status;
        }
        if (data.progress !== undefined) {
          jobs.value[jobIndex].progress = data.progress;
        }
      } else {
        jobs.value.unshift({
          id: data.jobId,
          name: data.name || 'Unknown Job',
          status: data.status || 'IN_PROGRESS',
          progress: data.progress || 0,
          createdAt: data.createdAt || new Date().toISOString(),
          customComponent: data.customComponent,
        });
      }
    });


    try {
      const res = await callAdminForthApi({
        path: `/plugin/${props.meta.pluginInstanceId}/get-list-of-jobs`,
        method: 'POST',
      });
      jobs.value = res.jobs;
    } catch (error) {
      console.error('Error fetching jobs:', error);
    }
  });


  onUnmounted(() => {
    websocket.unsubscribe('/background-jobs');
  });

</script>


<style scoped lang="scss">
.ping-animation {
  animation: ping 1s cubic-bezier(0, 0, 1, 1) infinite;
}

@keyframes ping {
  75%, 100% {
    transform: scale(2);
    opacity: 0;
  }
}
</style>